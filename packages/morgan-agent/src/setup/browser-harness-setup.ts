import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, getBundledBrowserHarnessDir } from "../config.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "../utils/child-process.ts";
import type { SetupPrompter } from "./prompter.ts";

export interface BrowserHarnessSetupResult {
	status: "ready" | "pending" | "skipped";
	messages: string[];
}

export interface BrowserHarnessSetupOptions {
	agentDir?: string;
	force?: boolean;
	prompter: SetupPrompter;
	runner?: BrowserHarnessRunner;
}

export interface BrowserHarnessRunner {
	commandExists(command: string): boolean;
	run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<number>;
}

class DefaultBrowserHarnessRunner implements BrowserHarnessRunner {
	commandExists(command: string): boolean {
		const result = spawnProcessSync(command, ["--version"], {
			encoding: "utf-8",
			stdio: ["ignore", "ignore", "ignore"],
		});
		return result.status === 0;
	}

	async run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<number> {
		const child = spawnProcess(command, args, {
			stdio: "inherit",
			env: options.env,
		});
		return (await waitForChildProcess(child)) ?? 1;
	}
}

async function runWithSuspendedPrompter(
	prompter: SetupPrompter,
	command: string,
	args: string[],
	runner: BrowserHarnessRunner,
	options?: { env?: NodeJS.ProcessEnv },
): Promise<number> {
	await prompter.suspend?.();
	try {
		return await runner.run(command, args, options);
	} finally {
		await prompter.resume?.();
	}
}

function getManagedBrowserHarnessDir(agentDir: string): string {
	return join(agentDir, "browser-harness");
}

function copyBundledHarness(targetDir: string, force: boolean): string | undefined {
	const sourceDir = getBundledBrowserHarnessDir();
	if (!existsSync(join(sourceDir, "pyproject.toml")) || !existsSync(join(sourceDir, "SKILL.md"))) {
		return `Bundled browser-harness files were not found at ${sourceDir}.`;
	}

	if (existsSync(targetDir)) {
		if (!force) {
			return undefined;
		}
		rmSync(targetDir, { recursive: true, force: true });
	}

	mkdirSync(dirname(targetDir), { recursive: true, mode: 0o700 });
	cpSync(sourceDir, targetDir, {
		recursive: true,
		filter: (source) => !source.includes(`${join(".git")}`),
	});
	return undefined;
}

function getUvInstallPathEnv(): NodeJS.ProcessEnv {
	const localBin = join(process.env.HOME ?? "", ".local", "bin");
	if (!localBin || process.env.PATH?.split(":").includes(localBin)) {
		return { ...process.env };
	}
	return { ...process.env, PATH: `${localBin}:${process.env.PATH ?? ""}` };
}

export async function setupBrowserHarness(options: BrowserHarnessSetupOptions): Promise<BrowserHarnessSetupResult> {
	const runner = options.runner ?? new DefaultBrowserHarnessRunner();
	const agentDir = options.agentDir ?? getAgentDir();
	const targetDir = getManagedBrowserHarnessDir(agentDir);
	const messages: string[] = [];

	const copyError = copyBundledHarness(targetDir, options.force ?? false);
	if (copyError) {
		return { status: "pending", messages: [copyError] };
	}
	messages.push(`Browser harness checkout: ${targetDir}`);

	if (!runner.commandExists("uv")) {
		const shouldInstallUv = await options.prompter.confirm(
			"uv is required for browser-harness. Install uv with Astral's official installer?",
			true,
		);
		if (!shouldInstallUv) {
			return {
				status: "pending",
				messages: [...messages, "uv is not installed. Run `curl -LsSf https://astral.sh/uv/install.sh | sh`."],
			};
		}

		const uvInstallCode = await runWithSuspendedPrompter(
			options.prompter,
			"sh",
			["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
			runner,
		);
		if (uvInstallCode !== 0) {
			return {
				status: "pending",
				messages: [...messages, `uv installer exited with code ${uvInstallCode ?? "unknown"}.`],
			};
		}
	}

	const env = getUvInstallPathEnv();
	const installCode = await runWithSuspendedPrompter(
		options.prompter,
		"uv",
		["tool", "install", "-e", targetDir],
		runner,
		{
			env,
		},
	);
	if (installCode !== 0) {
		return {
			status: "pending",
			messages: [...messages, `browser-harness install exited with code ${installCode ?? "unknown"}.`],
		};
	}

	const doctorCode = await runWithSuspendedPrompter(options.prompter, "browser-harness", ["--doctor"], runner, {
		env,
	});
	if (doctorCode !== 0) {
		return {
			status: "pending",
			messages: [
				...messages,
				"browser-harness installed, but the browser connection is not ready.",
				"Open Chrome and enable remote debugging at chrome://inspect/#remote-debugging, then run `browser-harness --doctor`.",
			],
		};
	}

	return { status: "ready", messages: [...messages, "browser-harness is ready."] };
}
