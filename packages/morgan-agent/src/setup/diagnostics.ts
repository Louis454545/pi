import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getSelfUpdateCommand, PACKAGE_NAME } from "../config.ts";
import type { AuthStorage } from "../core/auth-storage.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "../utils/child-process.ts";

export type DiagnosticStatus = "ok" | "warn" | "fail";

export interface SetupDiagnostic {
	status: DiagnosticStatus;
	label: string;
	message: string;
	nextAction?: string;
}

export interface DiagnosticRunner {
	commandExists(command: string): boolean;
	run(command: string, args: string[]): Promise<number>;
}

class DefaultDiagnosticRunner implements DiagnosticRunner {
	commandExists(command: string): boolean {
		const result = spawnProcessSync(command, ["--version"], {
			encoding: "utf-8",
			stdio: ["ignore", "ignore", "ignore"],
		});
		return result.status === 0;
	}

	async run(command: string, args: string[]): Promise<number> {
		const child = spawnProcess(command, args, {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return (await waitForChildProcess(child)) ?? 1;
	}
}

export interface CollectSetupDiagnosticsOptions {
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	settingsPath: string;
	runner?: DiagnosticRunner;
}

function statusText(status: DiagnosticStatus): string {
	switch (status) {
		case "ok":
			return chalk.green("ok");
		case "warn":
			return chalk.yellow("warn");
		case "fail":
			return chalk.red("fail");
	}
}

export function formatDiagnostic(diagnostic: SetupDiagnostic): string {
	const next = diagnostic.nextAction ? ` Next: ${diagnostic.nextAction}` : "";
	return `${statusText(diagnostic.status)} ${diagnostic.label}: ${diagnostic.message}${next}`;
}

export async function collectSetupDiagnostics(options: CollectSetupDiagnosticsOptions): Promise<SetupDiagnostic[]> {
	const runner = options.runner ?? new DefaultDiagnosticRunner();
	const diagnostics: SetupDiagnostic[] = [];
	const settingsExists = existsSync(options.settingsPath);
	const provider = options.settingsManager.getDefaultProvider();
	const modelId = options.settingsManager.getDefaultModel();

	diagnostics.push(
		settingsExists
			? { status: "ok", label: "settings", message: options.settingsPath }
			: {
					status: "fail",
					label: "settings",
					message: "global settings file is missing",
					nextAction: "morgan setup",
				},
	);

	if (!provider || !modelId) {
		diagnostics.push({
			status: "fail",
			label: "model",
			message: "default provider/model is not configured",
			nextAction: "morgan setup",
		});
	} else {
		const model = options.modelRegistry.find(provider, modelId);
		diagnostics.push(
			model
				? { status: "ok", label: "model", message: `${provider}/${modelId}` }
				: {
						status: "fail",
						label: "model",
						message: `${provider}/${modelId} was not found`,
						nextAction: "morgan setup --force",
					},
		);

		const authStatus = options.modelRegistry.getProviderAuthStatus(provider);
		diagnostics.push(
			authStatus.source
				? {
						status: "ok",
						label: "auth",
						message: authStatus.label
							? `${provider} via ${authStatus.label}`
							: `${provider} via ${authStatus.source}`,
					}
				: {
						status: "fail",
						label: "auth",
						message: `no credentials found for ${provider}`,
						nextAction: "morgan setup --force",
					},
		);
	}

	diagnostics.push(
		options.settingsManager.getEnableSkillCommands()
			? { status: "ok", label: "skills", message: "skill commands enabled" }
			: {
					status: "warn",
					label: "skills",
					message: "skill commands are disabled",
					nextAction: "morgan setup --force",
				},
	);

	const browserHarnessDir = join(options.agentDir, "browser-harness");
	diagnostics.push(
		existsSync(join(browserHarnessDir, "SKILL.md"))
			? { status: "ok", label: "browser checkout", message: browserHarnessDir }
			: {
					status: "warn",
					label: "browser checkout",
					message: "browser harness is not installed",
					nextAction: "morgan setup --force",
				},
	);

	const uvExists = runner.commandExists("uv");
	diagnostics.push(
		uvExists
			? { status: "ok", label: "uv", message: "available" }
			: {
					status: "warn",
					label: "uv",
					message: "not found",
					nextAction: "install uv or run morgan setup --force",
				},
	);

	if (runner.commandExists("browser-harness")) {
		const code = await runner.run("browser-harness", ["--doctor"]);
		diagnostics.push(
			code === 0
				? { status: "ok", label: "browser doctor", message: "ready" }
				: {
						status: "warn",
						label: "browser doctor",
						message: `browser-harness --doctor exited with code ${code}`,
						nextAction: "browser-harness --doctor",
					},
		);
	} else {
		diagnostics.push({
			status: "warn",
			label: "browser doctor",
			message: "browser-harness command not found",
			nextAction: "morgan setup --force",
		});
	}

	const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, options.settingsManager.getGlobalSettings().npmCommand);
	diagnostics.push(
		selfUpdateCommand
			? { status: "ok", label: "self-update", message: selfUpdateCommand.display }
			: {
					status: "warn",
					label: "self-update",
					message: "automatic self-update is unavailable for this install",
					nextAction: "morgan update self",
				},
	);

	return diagnostics;
}

export function hasFailingDiagnostics(diagnostics: readonly SetupDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.status === "fail");
}
