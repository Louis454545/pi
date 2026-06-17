import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { shouldRunStartupSetup } from "../src/main.ts";

describe("startup setup gate", () => {
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "morgan-startup-setup-"));
		settingsPath = join(tempDir, "settings.json");
	});

	afterEach(() => {
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
		expect(shouldRunStartupSetup("print", parseArgs(["--print", "hello"]), settingsPath)).toBe(false);
		expect(shouldRunStartupSetup("json", parseArgs(["--mode", "json"]), settingsPath)).toBe(false);
		expect(shouldRunStartupSetup("rpc", parseArgs(["--mode", "rpc"]), settingsPath)).toBe(false);
	});
});
