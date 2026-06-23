/**
 * Main entry point for the universal agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type ImageContent, modelsAreEqual } from "@earendil-works/morgan-ai";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { ENV_GLOBAL_CONVERSATION_LOCK_HELD, getAgentDir, getPackageDir, getSettingsPath, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import { acquireGlobalConversationLock, exportSessionToJsonl, SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { handleDaemonCommand } from "./daemon/command.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { handleDoctorCommand } from "./setup/doctor-cli.ts";
import { SetupCancelledError } from "./setup/prompter.ts";
import { handleSetupCommand, runSetup } from "./setup/setup-cli.ts";
import { isLocalPath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

type AppMode = "interactive" | "print" | "json" | "rpc";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

export function shouldRunStartupSetup(
	appMode: AppMode,
	parsed: Args,
	settingsPath: string = getSettingsPath(),
): boolean {
	return (
		appMode === "interactive" &&
		!parsed.help &&
		parsed.listModels === undefined &&
		!parsed.export &&
		!existsSync(settingsPath)
	);
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

function createSessionManager(
	parsed: Args,
	agentDir: string,
	cwd: string,
	sessionDir: string | undefined,
): SessionManager {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd);
	}

	return SessionManager.openGlobal(agentDir, { cwd, sessionDir });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function exportGlobalConversation(outputPath: string, agentDir: string, cwd: string): Promise<void> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(settingsManager, "export session lookup"));
	const sessionDir = settingsManager.getSessionDir();
	const releaseGlobalLock = await acquireGlobalConversationLock(agentDir, sessionDir);
	try {
		const sessionManager = SessionManager.openGlobal(agentDir, { cwd, sessionDir });
		console.log(`Exported to: ${exportSessionToJsonl(sessionManager, outputPath)}`);
	} finally {
		await releaseGlobalLock();
	}
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.MORGAN_OFFLINE);
	if (offlineMode) {
		process.env.MORGAN_OFFLINE = "1";
		process.env.MORGAN_SKIP_VERSION_CHECK = "1";
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

	if (await handleDaemonCommand(args)) {
		return;
	}

	if (await handleDoctorCommand(args)) {
		return;
	}

	const setupCommand = await handleSetupCommand(args);
	if (setupCommand.handled) {
		if (!setupCommand.launchArgs) {
			return;
		}
		args = setupCommand.launchArgs;
	}

	if (await handlePackageCommand(args, { extensionFactories: options?.extensionFactories })) {
		process.exit(process.exitCode ?? 0);
		return;
	}

	if (await handleConfigCommand(args, { extensionFactories: options?.extensionFactories })) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	if (parsed.help) {
		printHelp();
		process.exit(0);
	}

	const launchCwd = process.cwd();
	const agentDir = getAgentDir();
	const cwd = homedir();
	if (parsed.export) {
		await exportGlobalConversation(parsed.export, agentDir, cwd);
		return;
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (shouldRunStartupSetup(appMode, parsed)) {
		try {
			await runSetup();
		} catch (error) {
			if (error instanceof SetupCancelledError) {
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		time("startupSetup");
	}

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));
	const sessionDir = startupSettingsManager.getSessionDir();
	const shouldUsePersistentGlobalConversation =
		!parsed.noSession &&
		!parsed.help &&
		parsed.listModels === undefined &&
		process.env[ENV_GLOBAL_CONVERSATION_LOCK_HELD] !== "1";
	let releaseGlobalLock: (() => Promise<void>) | undefined;
	if (shouldUsePersistentGlobalConversation) {
		releaseGlobalLock = await acquireGlobalConversationLock(agentDir, sessionDir);
	}
	let sessionManager: SessionManager;
	try {
		sessionManager = createSessionManager(parsed, agentDir, cwd, sessionDir);
	} catch (error) {
		await releaseGlobalLock?.();
		throw error;
	}
	time("createSessionManager");

	const resolvedExtensionPaths = resolveCliPaths(launchCwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(launchCwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(launchCwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(launchCwd, parsed.themes);
	const authStorage = AuthStorage.create();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			settingsManager: runtimeSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		const { settingsManager, modelRegistry, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRegistry,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
		});
	} catch (error) {
		await releaseGlobalLock?.();
		throw error;
	}
	runtime.setReleaseLock(releaseGlobalLock);
	releaseGlobalLock = undefined;
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRegistry } = services;
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		await runtime.dispose();
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		await runtime.dispose();
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		await runtime.dispose();
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.MORGAN_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: MORGAN_STARTUP_BENCHMARK only supports interactive mode"));
		await runtime.dispose();
		process.exit(1);
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		const interactiveMode = new InteractiveMode(runtime, {
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			await runtime.dispose();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
