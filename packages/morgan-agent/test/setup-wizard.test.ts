import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthLoginCallbacks } from "@earendil-works/morgan-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BrowserHarnessRunner } from "../src/setup/browser-harness-setup.ts";
import type { SelectOption, SetupPrompter } from "../src/setup/prompter.ts";
import { handleSetupCommand, reloadRunningDaemonAfterSetup } from "../src/setup/setup-cli.ts";
import { SetupStateStore } from "../src/setup/setup-state.ts";
import { runSetupWizard } from "../src/setup/setup-wizard.ts";
import type {
	TelegramAllowedPeer,
	TelegramBotIdentity,
	TelegramBridgeClient,
} from "../src/setup/telegram-bridge-setup.ts";

class FakePrompter implements SetupPrompter {
	readonly messages: string[] = [];
	readonly oauthLogins: string[] = [];
	readonly selectMessages: string[] = [];
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

	async select<T extends string>(message: string, options: SelectOption<T>[]): Promise<T> {
		this.selectMessages.push(message);
		const value = this.selections.shift();
		if (value === undefined) {
			return options[0].id;
		}
		if (!options.some((option) => option.id === value)) {
			throw new Error(`Selection ${value} is not available`);
		}
		return value as T;
	}

	async loginOAuth(
		providerId: string,
		_providerName: string,
		_usesCallbackServer: boolean,
		_login: (callbacks: OAuthLoginCallbacks) => Promise<void>,
	): Promise<void> {
		this.oauthLogins.push(providerId);
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

class FakeTelegramBridgeClient implements TelegramBridgeClient {
	readonly calls: string[] = [];
	readonly bot: TelegramBotIdentity;
	readonly peer: TelegramAllowedPeer | undefined;
	latestOffset = 0;

	constructor(options: { bot?: TelegramBotIdentity; peer?: TelegramAllowedPeer } = {}) {
		this.bot = options.bot ?? { id: 42, username: "morgan_test_bot", firstName: "Morgan" };
		this.peer = options.peer;
	}

	async validateBot(): Promise<TelegramBotIdentity> {
		this.calls.push("validateBot");
		return this.bot;
	}

	async clearWebhook(): Promise<void> {
		this.calls.push("clearWebhook");
	}

	async getLatestOffset(): Promise<number> {
		this.calls.push("getLatestOffset");
		return this.latestOffset;
	}

	async waitForStart(): Promise<TelegramAllowedPeer | undefined> {
		this.calls.push("waitForStart");
		return this.peer;
	}
}

describe("setup wizard", () => {
	let tempDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
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
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		return { agentDir, authStorage, modelRegistry, settingsManager };
	}

	it("stores API key defaults and installs the managed browser harness", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(
			["api-key", "anthropic", "claude-opus-4-8", "medium", "tui", "skip", "install"],
			["sk-test"],
		);
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
		expect(result.communication.status).toBe("skipped");
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
		const prompter = new FakePrompter(["custom", "skip", "tui", "skip", "install"]);
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

	it("can skip browser harness setup", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["custom", "skip", "tui", "skip", "skip"]);
		const browserRunner = new FakeBrowserRunner(true);

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
		});

		expect(result.browser.status).toBe("skipped");
		expect(browserRunner.calls).toEqual([]);
		expect(prompter.messages).toContain("Browser: skipped");
	});

	it("skips daemon autostart prompt on unsupported platforms", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["custom", "skip", "tui", "skip"]);
		const browserRunner = new FakeBrowserRunner(true);

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
			daemonAutostartRunner: { platform: "win32" },
		});

		expect(result.daemon.status).toBe("skipped");
		expect(result.browser.status).toBe("skipped");
		expect(settingsManager.getDaemonEnabled()).toBe(true);
		expect(settingsManager.getDaemonStartAtLogin()).toBe(false);
		expect(prompter.selectMessages).not.toContain("Start Morgan automatically at login?");
	});

	it("can defer browser harness setup", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["custom", "skip", "tui", "skip", "later"]);
		const browserRunner = new FakeBrowserRunner(true);

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
		});

		expect(result.browser.status).toBe("pending");
		expect(result.browser.messages.join("\n")).toContain("install later");
		expect(browserRunner.calls).toEqual([]);
	});

	it("resumes an incomplete setup state without storing secrets", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const stateStore = new SetupStateStore(agentDir);
		stateStore.save({ version: 1, profile: "custom", completedSteps: ["authModel"] });
		const prompter = new FakePrompter(["resume", "tui", "skip", "later"]);
		const browserRunner = new FakeBrowserRunner(true);

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
			setupStateStore: stateStore,
		});

		expect(result.launchMorgan).toBe(true);
		expect(result.browser.status).toBe("pending");
		expect(existsSync(stateStore.getPath())).toBe(false);
	});

	it("logs in to subscription providers during setup", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["subscription", "anthropic", "claude-opus-4-8", "medium", "tui", "skip"]);
		const browserRunner = new FakeBrowserRunner(true);

		await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
			force: true,
		});

		expect(prompter.oauthLogins).toEqual(["anthropic"]);
		expect(settingsManager.getDefaultProvider()).toBe("anthropic");
		expect(settingsManager.getDefaultModel()).toBe("claude-opus-4-8");
		expect(prompter.messages.some((message) => message.startsWith("Logged in to "))).toBe(true);
	});

	it("installs an editable Telegram bridge when selected", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["custom", "skip", "telegram", "manual", "skip"], ["123456:token", "123,-456"]);
		const browserRunner = new FakeBrowserRunner(true);
		const telegramClient = new FakeTelegramBridgeClient();
		telegramClient.latestOffset = 99;

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
			telegramClient,
		});

		expect(result.communication.status).toBe("ready");
		expect(telegramClient.calls).toEqual(["validateBot", "clearWebhook", "getLatestOffset"]);
		const bridgeDir = join(agentDir, "extensions", "triggers", "telegram-bridge");
		expect(existsSync(join(bridgeDir, "index.ts"))).toBe(true);
		expect(existsSync(join(bridgeDir, "README.md"))).toBe(true);

		const config = JSON.parse(readFileSync(join(bridgeDir, "config.json"), "utf-8")) as {
			enabled?: boolean;
			botToken?: string;
			botUsername?: string;
			allowedChatIds?: number[];
			allowedUserIds?: number[];
			dataDir?: string;
		};
		expect(config).toMatchObject({
			enabled: true,
			botToken: "123456:token",
			botUsername: "morgan_test_bot",
			allowedChatIds: [123, -456],
			allowedUserIds: [123],
			dataDir: join(agentDir, "telegram-bridge"),
		});

		const state = JSON.parse(readFileSync(join(bridgeDir, "state.json"), "utf-8")) as { offset?: number };
		expect(state.offset).toBe(99);

		const loader = new DefaultResourceLoader({ cwd: agentDir, agentDir, settingsManager });
		await loader.reload();
		const bridgeExtension = loader
			.getExtensions()
			.extensions.find((extension) => extension.path === join(bridgeDir, "index.ts"));
		expect(bridgeExtension?.tools.has("send_message")).toBe(true);
		expect(bridgeExtension?.tools.has("telegram_send_file")).toBe(false);
	});

	it("pairs the Telegram allowlist with /start when available", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["custom", "skip", "telegram", "pair", "skip"], ["123456:token"]);
		const browserRunner = new FakeBrowserRunner(true);
		const telegramClient = new FakeTelegramBridgeClient({
			peer: { chatId: 555, userId: 777, offset: 12, label: "Louis" },
		});

		const result = await runSetupWizard({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			prompter,
			browserRunner,
			telegramClient,
		});

		expect(result.communication.status).toBe("ready");
		expect(telegramClient.calls).toEqual(["validateBot", "clearWebhook", "waitForStart"]);
		const bridgeDir = join(agentDir, "extensions", "triggers", "telegram-bridge");
		const config = JSON.parse(readFileSync(join(bridgeDir, "config.json"), "utf-8")) as {
			allowedChatIds?: number[];
			allowedUserIds?: number[];
		};
		expect(config.allowedChatIds).toEqual([555]);
		expect(config.allowedUserIds).toEqual([777]);
	});

	it("asks before installing uv when it is missing", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager } = createSetup();
		const prompter = new FakePrompter(["custom", "skip", "tui", "skip", "install"], [], [true]);
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
			expect(stdout).not.toContain("--profile");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("reloads an already-running daemon after setup changes", async () => {
		const calls: string[] = [];
		const client = {
			async connect() {
				calls.push("connect");
			},
			async reload() {
				calls.push("reload");
			},
			close() {
				calls.push("close");
			},
		};

		await expect(reloadRunningDaemonAfterSetup(client)).resolves.toBe("reloaded");
		expect(calls).toEqual(["connect", "reload", "close"]);
	});

	it("does not fail setup activation when no daemon is running", async () => {
		const calls: string[] = [];
		const client = {
			async connect() {
				calls.push("connect");
				throw new Error("not running");
			},
			async reload() {
				calls.push("reload");
			},
			close() {
				calls.push("close");
			},
		};

		await expect(reloadRunningDaemonAfterSetup(client)).resolves.toBe("not-running");
		expect(calls).toEqual(["connect", "close"]);
	});

	it("runs setup non-interactively", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "morgan-setup-cli-"));
		const agentDir = join(tempDir, "agent");
		process.env[ENV_AGENT_DIR] = agentDir;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(
				handleSetupCommand([
					"setup",
					"--yes",
					"--no-launch",
					"--browser",
					"later",
					"--provider",
					"anthropic",
					"--model",
					"claude-opus-4-8",
					"--thinking",
					"low",
					"--api-key",
					"sk-test",
				]),
			).resolves.toEqual({ handled: true });

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("sk-test"));
			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
				defaultProvider?: string;
				defaultModel?: string;
				defaultThinkingLevel?: string;
			};
			expect(settings.defaultProvider).toBe("anthropic");
			expect(settings.defaultModel).toBe("claude-opus-4-8");
			expect(settings.defaultThinkingLevel).toBe("low");
			const auth = readFileSync(join(agentDir, "auth.json"), "utf-8");
			expect(auth).toContain("sk-test");
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain("sk-test");
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
