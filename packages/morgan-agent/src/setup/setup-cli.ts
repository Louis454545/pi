import { homedir } from "node:os";
import type { ThinkingLevel } from "@earendil-works/morgan-agent-core";
import { setKeybindings } from "@earendil-works/morgan-tui";
import chalk from "chalk";
import { isValidThinkingLevel } from "../cli/args.ts";
import { APP_NAME, getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { DaemonClient } from "../daemon/client.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { type SelectOption, SetupCancelledError, type SetupPrompter, TuiSetupPrompter } from "./prompter.ts";
import type { BrowserSetupChoice, CommunicationSetupChoice, DaemonAutostartSetupChoice } from "./setup-state.ts";
import { runSetupWizard, type SetupWizardResult } from "./setup-wizard.ts";

export interface SetupCommandResult {
	handled: boolean;
	launchArgs?: string[];
}

interface SetupCommandOptions {
	force: boolean;
	noLaunch: boolean;
	yes: boolean;
	help: boolean;
	browserChoice?: BrowserSetupChoice;
	communicationChoice?: CommunicationSetupChoice;
	daemonAutostartChoice?: DaemonAutostartSetupChoice;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	apiKey?: string;
	invalidOption?: string;
	missingOptionValue?: string;
	invalidValue?: string;
}

export interface RunSetupOptions {
	force?: boolean;
	yes?: boolean;
	browserChoice?: BrowserSetupChoice;
	communicationChoice?: CommunicationSetupChoice;
	daemonAutostartChoice?: DaemonAutostartSetupChoice;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	apiKey?: string;
}

interface SetupDaemonClient {
	connect(): Promise<void>;
	reload(): Promise<void>;
	close(): void;
}

export async function reloadRunningDaemonAfterSetup(
	client: SetupDaemonClient = new DaemonClient({ requestTimeoutMs: 30000 }),
): Promise<"reloaded" | "not-running" | "failed"> {
	let connected = false;
	try {
		await client.connect();
		connected = true;
		await client.reload();
		return "reloaded";
	} catch {
		return connected ? "failed" : "not-running";
	} finally {
		client.close();
	}
}

function printSetupHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} setup [--force] [--no-launch] [--yes]

Configure Morgan's global defaults and bundled capabilities.

Options:
  --force                         Re-run setup steps even when settings already exist
  --no-launch                     Do not start Morgan after setup
  --yes                           Run without interactive prompts when all values are provided
  --browser install|later|skip    Configure browser control
  --communication tui|telegram    Configure communication channel
  --daemon-autostart enable|disable|skip
                                  Configure launch-at-login on Linux/macOS
  --provider <id>                 Set default provider
  --model <id>                    Set default model
  --thinking <level>              Set thinking level: off, minimal, low, medium, high, xhigh
  --api-key <value>               Store API key for --provider
`);
}

function readOptionValue(
	rest: string[],
	index: number,
	option: string,
): { value?: string; nextIndex: number; missing?: string } {
	const value = rest[index + 1];
	if (!value || value.startsWith("-")) {
		return { nextIndex: index, missing: option };
	}
	return { value, nextIndex: index + 1 };
}

function parseSetupCommand(args: string[]): SetupCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "setup") {
		return undefined;
	}

	let force = false;
	let noLaunch = false;
	let yes = false;
	let help = false;
	let invalidOption: string | undefined;
	let missingOptionValue: string | undefined;
	let invalidValue: string | undefined;
	let browserChoice: BrowserSetupChoice | undefined;
	let communicationChoice: CommunicationSetupChoice | undefined;
	let daemonAutostartChoice: DaemonAutostartSetupChoice | undefined;
	let provider: string | undefined;
	let model: string | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	let apiKey: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "--force") {
			force = true;
		} else if (arg === "--no-launch") {
			noLaunch = true;
		} else if (arg === "--yes") {
			yes = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--browser") {
			const result = readOptionValue(rest, index, arg);
			index = result.nextIndex;
			if (result.missing) {
				missingOptionValue = missingOptionValue ?? result.missing;
			} else if (result.value === "install" || result.value === "later" || result.value === "skip") {
				browserChoice = result.value;
			} else {
				invalidValue = invalidValue ?? `${arg} must be install, later, or skip`;
			}
		} else if (arg === "--communication") {
			const result = readOptionValue(rest, index, arg);
			index = result.nextIndex;
			if (result.missing) {
				missingOptionValue = missingOptionValue ?? result.missing;
			} else if (result.value === "tui" || result.value === "telegram") {
				communicationChoice = result.value;
			} else {
				invalidValue = invalidValue ?? `${arg} must be tui or telegram`;
			}
		} else if (arg === "--daemon-autostart") {
			const result = readOptionValue(rest, index, arg);
			index = result.nextIndex;
			if (result.missing) {
				missingOptionValue = missingOptionValue ?? result.missing;
			} else if (result.value === "enable" || result.value === "disable" || result.value === "skip") {
				daemonAutostartChoice = result.value;
			} else {
				invalidValue = invalidValue ?? `${arg} must be enable, disable, or skip`;
			}
		} else if (arg === "--provider") {
			const result = readOptionValue(rest, index, arg);
			index = result.nextIndex;
			if (result.missing) missingOptionValue = missingOptionValue ?? result.missing;
			provider = result.value ?? provider;
		} else if (arg === "--model") {
			const result = readOptionValue(rest, index, arg);
			index = result.nextIndex;
			if (result.missing) missingOptionValue = missingOptionValue ?? result.missing;
			model = result.value ?? model;
		} else if (arg === "--thinking") {
			const result = readOptionValue(rest, index, arg);
			index = result.nextIndex;
			if (result.missing) {
				missingOptionValue = missingOptionValue ?? result.missing;
			} else if (result.value && isValidThinkingLevel(result.value)) {
				thinkingLevel = result.value;
			} else {
				invalidValue = invalidValue ?? `${arg} must be off, minimal, low, medium, high, or xhigh`;
			}
		} else if (arg === "--api-key") {
			const result = readOptionValue(rest, index, arg);
			index = result.nextIndex;
			if (result.missing) missingOptionValue = missingOptionValue ?? result.missing;
			apiKey = result.value ?? apiKey;
		} else {
			invalidOption = invalidOption ?? arg;
		}
	}

	return {
		force,
		noLaunch,
		yes,
		help,
		browserChoice,
		communicationChoice,
		daemonAutostartChoice,
		provider,
		model,
		thinkingLevel,
		apiKey,
		invalidOption,
		missingOptionValue,
		invalidValue,
	};
}

class NonInteractiveSetupPrompter implements SetupPrompter {
	info(message: string): void {
		console.log(message);
	}

	warn(message: string): void {
		console.error(message);
	}

	async confirm(): Promise<boolean> {
		throw new Error("Setup requires interactive confirmation. Provide explicit options or omit --yes.");
	}

	async input(): Promise<string> {
		throw new Error("Setup requires interactive input. Provide explicit options or omit --yes.");
	}

	async select<T extends string>(_message: string, options: SelectOption<T>[]): Promise<T> {
		if (options.length === 0) {
			throw new Error("Setup cannot select from an empty option list.");
		}
		throw new Error("Setup requires an interactive selection. Provide explicit options or omit --yes.");
	}

	async loginOAuth(): Promise<void> {
		throw new Error("Subscription login requires an interactive terminal.");
	}

	close(): void {}
}

export async function handleSetupCommand(args: string[]): Promise<SetupCommandResult> {
	const options = parseSetupCommand(args);
	if (!options) {
		return { handled: false };
	}

	if (options.help) {
		printSetupHelp();
		return { handled: true };
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Use "${APP_NAME} setup --help".`));
		process.exitCode = 1;
		return { handled: true };
	}

	if (options.invalidValue) {
		console.error(chalk.red(options.invalidValue));
		console.error(chalk.dim(`Use "${APP_NAME} setup --help".`));
		process.exitCode = 1;
		return { handled: true };
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "setup".`));
		console.error(chalk.dim(`Use "${APP_NAME} setup --help".`));
		process.exitCode = 1;
		return { handled: true };
	}

	if (options.yes && options.communicationChoice === "telegram") {
		console.error(chalk.red("Telegram setup requires an interactive terminal."));
		process.exitCode = 1;
		return { handled: true };
	}

	if (!options.yes && !process.stdin.isTTY) {
		console.error(chalk.red("Error: morgan setup requires an interactive terminal."));
		process.exitCode = 1;
		return { handled: true };
	}

	let result: SetupWizardResult;
	try {
		result = await runSetup({
			force: options.force,
			yes: options.yes,
			browserChoice: options.browserChoice,
			communicationChoice: options.communicationChoice,
			daemonAutostartChoice: options.daemonAutostartChoice,
			provider: options.provider,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			apiKey: options.apiKey,
		});
	} catch (error) {
		if (error instanceof SetupCancelledError) {
			process.exitCode = 1;
			return { handled: true };
		}
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
		return { handled: true };
	}

	const daemonReload = await reloadRunningDaemonAfterSetup();
	if (daemonReload === "reloaded") {
		console.log("Reloaded the running daemon to apply setup changes.");
	} else if (daemonReload === "failed") {
		console.error(chalk.yellow("Warning: setup completed, but the running daemon could not reload its resources."));
	}

	if (options.noLaunch || !result.launchMorgan) {
		return { handled: true };
	}
	return { handled: true, launchArgs: [] };
}

export async function runSetup(options: RunSetupOptions = {}): Promise<SetupWizardResult> {
	const agentDir = getAgentDir();
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const settingsManager = SettingsManager.create(homedir(), agentDir);
	initTheme(settingsManager.getTheme(), !options.yes);
	setKeybindings(KeybindingsManager.create());
	const prompter = options.yes
		? new NonInteractiveSetupPrompter()
		: new TuiSetupPrompter({ authStorage, modelRegistry, settingsManager });
	const authChoice =
		options.apiKey || options.provider ? (options.apiKey ? "api-key" : "skip") : options.yes ? "skip" : undefined;

	try {
		return await runSetupWizard({
			force: options.force ?? false,
			nonInteractive: options.yes,
			authChoice,
			provider: options.provider,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			apiKey: options.apiKey,
			communicationChoice: options.communicationChoice ?? (options.yes ? "tui" : undefined),
			browserChoice: options.browserChoice ?? (options.yes ? "later" : undefined),
			daemonAutostartChoice: options.daemonAutostartChoice,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
		});
	} finally {
		await prompter.close();
		stopThemeWatcher();
	}
}
