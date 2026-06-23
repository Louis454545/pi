import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";

const EXTENSION = `export default function (morgan) {
  morgan.registerCommand("hello", { handler: async () => {} });
}`;

describe("extension discovery", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "morgan-extension-discovery-"));
		dirs.push(dir);
		return dir;
	}

	it("loads global extensions from agentDir/extensions", async () => {
		const agentDir = tempDir();
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir);
		writeFileSync(join(extensionsDir, "hello.ts"), EXTENSION);

		const result = await discoverAndLoadExtensions([], agentDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions.map((extension) => extension.path)).toEqual([join(extensionsDir, "hello.ts")]);
	});

	it("does not discover extensions outside agentDir", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project", ".morgan", "extensions");
		mkdirSync(agentDir);
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "ignored.ts"), EXTENSION);

		const result = await discoverAndLoadExtensions([], agentDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toEqual([]);
	});

	it("loads an explicitly supplied extension", async () => {
		const agentDir = tempDir();
		const extensionPath = join(tempDir(), "explicit.ts");
		writeFileSync(extensionPath, EXTENSION);

		const result = await discoverAndLoadExtensions([extensionPath], agentDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions.map((extension) => extension.path)).toEqual([extensionPath]);
	});
});
