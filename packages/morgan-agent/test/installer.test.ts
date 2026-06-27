import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const installerPath = join(repoRoot, "scripts", "install.sh");
const buildBinariesPath = join(repoRoot, "scripts", "build-binaries.sh");

function expectedPlatform(): string {
	const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
	return `${os}-${arch}`;
}

describe("install.sh", () => {
	it.runIf(process.platform === "linux" || process.platform === "darwin")(
		"resolves release assets in dry-run mode",
		() => {
			const output = execFileSync("sh", [installerPath], {
				encoding: "utf-8",
				env: {
					...process.env,
					MORGAN_INSTALL_DRY_RUN: "1",
					MORGAN_INSTALL_BASE_URL: "https://example.test/releases/latest/download",
					MORGAN_INSTALL_DIR: "/tmp/morgan-current",
					MORGAN_INSTALL_BIN_DIR: "/tmp/bin",
				},
			});

			const platform = expectedPlatform();
			expect(output).toContain(`platform=${platform}`);
			expect(output).toContain(`archive=morgan-${platform}.tar.gz`);
			expect(output).toContain(
				`archive_url=https://example.test/releases/latest/download/morgan-${platform}.tar.gz`,
			);
			expect(output).toContain("checksums_url=https://example.test/releases/latest/download/SHA256SUMS");
			expect(output).toContain("install_dir=/tmp/morgan-current");
			expect(output).toContain("bin_dir=/tmp/bin");
		},
	);

	it("installs a launcher instead of a symlink", () => {
		const installer = readFileSync(installerPath, "utf-8");

		expect(installer).toContain('exec %s "$@"');
		expect(installer).not.toContain("ln -sf");
	});

	it("keeps checksum generation portable across Linux and macOS", () => {
		const buildScript = readFileSync(buildBinariesPath, "utf-8");

		expect(buildScript).toContain("command -v sha256sum");
		expect(buildScript).toContain("shasum -a 256");
		expect(buildScript).toContain('sha256_file "$archive" >> SHA256SUMS');
	});
});
