import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { collectSetupDiagnostics, type DiagnosticRunner } from "../src/setup/diagnostics.ts";

class FakeDiagnosticRunner implements DiagnosticRunner {
	private readonly commands: Set<string>;
	private readonly exitCode: number;

	constructor(commands: string[], exitCode = 0) {
		this.commands = new Set(commands);
		this.exitCode = exitCode;
	}

	commandExists(command: string): boolean {
		return this.commands.has(command);
	}

	async run(): Promise<number> {
		return this.exitCode;
	}
}

describe("setup diagnostics", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function createSetup() {
		tempDir = mkdtempSync(join(tmpdir(), "morgan-doctor-"));
		const agentDir = join(tempDir, "agent");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		return { agentDir, authStorage, modelRegistry, settingsManager, settingsPath: join(agentDir, "settings.json") };
	}

	it("fails when global settings are missing", async () => {
		const setup = createSetup();

		const diagnostics = await collectSetupDiagnostics({
			...setup,
			runner: new FakeDiagnosticRunner([]),
		});

		expect(diagnostics.some((diagnostic) => diagnostic.status === "fail" && diagnostic.label === "settings")).toBe(
			true,
		);
		expect(diagnostics.some((diagnostic) => diagnostic.label === "model" && diagnostic.status === "fail")).toBe(true);
	});

	it("accepts configured model and auth", async () => {
		const { agentDir, authStorage, modelRegistry, settingsManager, settingsPath } = createSetup();
		authStorage.set("anthropic", { type: "api_key", key: "sk-test" });
		modelRegistry.refresh();
		settingsManager.setDefaultModelAndProvider("anthropic", "claude-opus-4-8");
		settingsManager.setEnableSkillCommands(true);
		await settingsManager.flush();
		mkdirSync(join(agentDir, "browser-harness"), { recursive: true });
		writeFileSync(join(agentDir, "browser-harness", "SKILL.md"), "# Browser\n", "utf-8");

		const diagnostics = await collectSetupDiagnostics({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			settingsPath,
			runner: new FakeDiagnosticRunner(["uv", "browser-harness"]),
		});

		expect(diagnostics.find((diagnostic) => diagnostic.label === "settings")?.status).toBe("ok");
		expect(diagnostics.find((diagnostic) => diagnostic.label === "model")?.status).toBe("ok");
		expect(diagnostics.find((diagnostic) => diagnostic.label === "auth")?.status).toBe("ok");
		expect(diagnostics.find((diagnostic) => diagnostic.label === "browser doctor")?.status).toBe("ok");
	});
});
