import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "morgan-settings-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("loads only the global settings file", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		const projectDir = join(root, "project", ".morgan");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "settings.json"), JSON.stringify({ theme: "light" }));

		const manager = SettingsManager.create(join(root, "project"), agentDir);

		expect(manager.getTheme()).toBe("dark");
	});

	it("persists global changes", async () => {
		const manager = SettingsManager.create(root, agentDir);
		manager.setTheme("light");
		manager.setExtensionPaths(["extensions/example.ts"]);
		await manager.flush();

		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toMatchObject({
			theme: "light",
			extensions: ["extensions/example.ts"],
		});
	});

	it("does not create project configuration", async () => {
		const project = join(root, "project");
		mkdirSync(project);
		const manager = SettingsManager.create(project, agentDir);
		manager.setTheme("dark");
		await manager.flush();

		expect(existsSync(join(project, ".morgan"))).toBe(false);
	});

	it("reloads external global changes", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		const manager = SettingsManager.create(root, agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));

		await manager.reload();

		expect(manager.getTheme()).toBe("light");
	});

	it("reports invalid global JSON", () => {
		writeFileSync(join(agentDir, "settings.json"), "{invalid");
		const manager = SettingsManager.create(root, agentDir);

		expect(manager.drainErrors()).toHaveLength(1);
		expect(manager.drainErrors()).toEqual([]);
	});

	it("supports isolated in-memory settings", () => {
		const manager = SettingsManager.inMemory({ theme: "dark" });
		expect(manager.getTheme()).toBe("dark");
		manager.setTheme("light");
		expect(manager.getTheme()).toBe("light");
	});
});
