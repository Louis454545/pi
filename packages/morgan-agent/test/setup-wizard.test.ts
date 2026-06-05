import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BrowserHarnessRunner } from "../src/setup/browser-harness-setup.ts";
import type { SelectOption, SetupPrompter } from "../src/setup/prompter.ts";
import { handleSetupCommand } from "../src/setup/setup-cli.ts";
import { runSetupWizard } from "../src/setup/setup-wizard.ts";

class FakePrompter implements SetupPrompter {
	readonly messages: string[] = [];
	private readonly selections: string[];
	private readonly inputs: string[];
	private readonly confirmations: boolean[];

	constructor(selections: string[], inputs: string[] = [], confirmations: boolean[] = []) {
		this.selections = selections;
		this.inputs = inputs;
		this.confirmations = confirmations;
	}

	info(message: string): void {
		this.messages.push(message);
	}

	warn(message: string): void {
		this.messages.push(message);
	}

	async confirm(): Promise<boolean> {
		return this.confirmations.shift() ?? true;
	}

	async input(): Promise<string> {
		const value = this.inputs.shift();
		if (value === undefined) {
			throw new Error("No fake input queued");
		}
		return value;
	}

	async select<T extends string>(_message: string, options: SelectOption<T>[]): Promise<T> {
		const value = this.selections.shift();
		if (value === undefined) {
			return options[0].id;
		}
		if (!options.some((option) => option.id === value)) {
			throw new Error(`Selection ${value} is not available`);
		}
		return value as T;
	}

	close(): void {}
}

class FakeBrowserRunner implements BrowserHarnessRunner {
	readonly calls: Array<{ command: string; args: string[] }> = [];
	private readonly commandExistsValue: boolean;
	private readonly exitCodes: number[];

	constructor(commandExistsValue: boolean, exitCodes: number[] = []) {
		this.commandExistsValue = commandExistsValue;
		this.exitCodes = exitCodes;
	}

	commandExists(): boolean {
		return this.commandExistsValue;
	}

	async run(command: string, args: string[]): Promise<number> {
		this.calls.push({ command, args });
		return this.exitCodes.shift() ?? 0;
	}
}

describe("setup wizard", () => {
	let tempDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function createSetup() {
		tempDir = mkdtempSync(join(tmpdir(), "morgan-setup-"));
		const agentDir = join(tempDir, "agent");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const settingsManager = SettingsManager.create(tempDir, agentDir, { includeProjectSettings: false });
		return { agentDir, authStorage, modelRegistry, settingsManager };
	}

	it("stores API key defaults and installs the managed browser harness", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["api-key", "anthropic", "claude-opus-4-8", "medium"], ["sk-test"]);
		const browserRunner = new FakeBrowserRunner(true);

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
			force: true,
		});

		expect(result.launchMorgan).toBe(true);
		expect(result.browser.status).toBe("ready");
		expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
		expect(settingsManager.getDefaultProvider()).toBe("anthropic");
		expect(settingsManager.getDefaultModel()).toBe("claude-opus-4-8");
		expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
		expect(browserRunner.calls.map((call) => [call.command, ...call.args])).toEqual([
			["uv", "tool", "install", "-e", join(agentDir, "browser-harness")],
			["browser-harness", "--doctor"],
		]);
		expect(existsSync(join(agentDir, "browser-harness", "SKILL.md"))).toBe(true);

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
			enableSkillCommands?: boolean;
		};
		expect(settings.enableSkillCommands).toBe(true);
	});

	it("keeps Morgan setup successful when browser doctor is pending", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["skip"]);
		const browserRunner = new FakeBrowserRunner(true, [0, 7]);

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
		});

		expect(result.launchMorgan).toBe(true);
		expect(result.browser.status).toBe("pending");
		expect(result.browser.messages.join("\n")).toContain("browser connection is not ready");
	});

	it("asks before installing uv when it is missing", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["skip"], [], [true]);
		const browserRunner = new FakeBrowserRunner(false);

		await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
		});

		expect(browserRunner.calls.map((call) => [call.command, ...call.args])).toEqual([
			["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
			["uv", "tool", "install", "-e", join(agentDir, "browser-harness")],
			["browser-harness", "--doctor"],
		]);
	});

	it("shows setup command help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handleSetupCommand(["setup", "--help"])).resolves.toEqual({ handled: true });
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("morgan setup [--force] [--no-launch]");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("rejects unknown setup options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handleSetupCommand(["setup", "--bad"])).resolves.toEqual({ handled: true });
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --bad for "setup".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
