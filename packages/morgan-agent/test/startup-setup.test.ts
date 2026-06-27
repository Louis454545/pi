import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { isStdoutTakenOver, restoreStdout } from "../src/core/output-guard.ts";
import { getDaemonIncompatibleReason, main, shouldRunStartupSetup } from "../src/main.ts";

describe("startup setup gate", () => {
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "morgan-startup-setup-"));
		settingsPath = join(tempDir, "settings.json");
	});

	afterEach(() => {
		restoreStdout();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs for interactive startup when global settings are missing", () => {
		expect(shouldRunStartupSetup("interactive", parseArgs([]), settingsPath)).toBe(true);
	});

	it("skips when global settings already exist", () => {
		writeFileSync(settingsPath, "{}\n", "utf-8");

		expect(shouldRunStartupSetup("interactive", parseArgs([]), settingsPath)).toBe(false);
	});

	it("skips metadata and non-interactive modes", () => {
		expect(shouldRunStartupSetup("interactive", parseArgs(["--help"]), settingsPath)).toBe(false);
		expect(shouldRunStartupSetup("interactive", parseArgs(["--list-models"]), settingsPath)).toBe(false);
		expect(shouldRunStartupSetup("interactive", parseArgs(["--export", "session.jsonl"]), settingsPath)).toBe(false);
		expect(shouldRunStartupSetup("print", parseArgs(["--print", "hello"]), settingsPath)).toBe(false);
		expect(shouldRunStartupSetup("json", parseArgs(["--mode", "json"]), settingsPath)).toBe(false);
		expect(shouldRunStartupSetup("rpc", parseArgs(["--mode", "rpc"]), settingsPath)).toBe(false);
	});

	it("keeps offline mode out of daemon startup", () => {
		expect(getDaemonIncompatibleReason(parseArgs(["--offline", "-p", "hello"]))).toContain("offline mode");
	});

	it("exports without startup setup or stdout takeover", async () => {
		const oldAgentDir = process.env[ENV_AGENT_DIR];
		const agentDir = join(tempDir, "agent");
		const outputPath = join(tempDir, "session.jsonl");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			await main(["--export", outputPath]);
		} finally {
			if (oldAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = oldAgentDir;
			}
			log.mockRestore();
		}

		expect(isStdoutTakenOver()).toBe(false);
		expect(existsSync(outputPath)).toBe(true);
		expect(readFileSync(outputPath, "utf-8")).toContain('"type":"session"');
	});
});
