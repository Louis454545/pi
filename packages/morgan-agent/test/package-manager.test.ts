import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("DefaultPackageManager", () => {
	let root: string;
	let agentDir: string;
	let settings: SettingsManager;
	let manager: DefaultPackageManager;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "morgan-packages-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir);
		settings = SettingsManager.inMemory();
		manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("auto-discovers only global resources", async () => {
		const globalExtensions = join(agentDir, "extensions");
		const projectExtensions = join(root, ".morgan", "extensions");
		mkdirSync(globalExtensions);
		mkdirSync(projectExtensions, { recursive: true });
		writeFileSync(join(globalExtensions, "global.ts"), "export default function() {}");
		writeFileSync(join(projectExtensions, "ignored.ts"), "export default function() {}");

		const result = await manager.resolve();

		expect(result.extensions.map((resource) => resource.path)).toContain(join(globalExtensions, "global.ts"));
		expect(result.extensions.map((resource) => resource.path)).not.toContain(join(projectExtensions, "ignored.ts"));
	});

	it("resolves configured resource paths relative to agentDir", async () => {
		const extensions = join(agentDir, "custom");
		mkdirSync(extensions);
		const extension = join(extensions, "explicit.ts");
		writeFileSync(extension, "export default function() {}");
		settings.setExtensionPaths(["custom/explicit.ts"]);

		const result = await manager.resolve();

		expect(result.extensions.some((resource) => resource.path === extension && resource.enabled)).toBe(true);
	});

	it("resolves a globally configured local package", async () => {
		const packageDir = join(root, "package");
		mkdirSync(join(packageDir, "extensions"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "local-extension", morgan: { extensions: ["extensions/index.ts"] } }),
		);
		const extension = join(packageDir, "extensions", "index.ts");
		writeFileSync(extension, "export default function() {}");
		settings.setPackages([packageDir]);

		const result = await manager.resolve();

		const resource = result.extensions.find((candidate) => candidate.path === extension);
		expect(resource?.metadata.scope).toBe("user");
		expect(resource?.metadata.origin).toBe("package");
	});

	it("stores configured packages globally", () => {
		const packageDir = join(root, "package");
		mkdirSync(packageDir);

		expect(manager.addSourceToSettings(packageDir)).toBe(true);
		expect(settings.getGlobalSettings().packages).toEqual([relative(agentDir, packageDir)]);
	});
});
