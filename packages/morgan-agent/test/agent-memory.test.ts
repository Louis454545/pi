import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentMemoryPromptContext } from "../src/core/agent-memory.ts";

describe("agent memory prompt context", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	function createTempDir(): string {
		const tempDir = join(tmpdir(), `morgan-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	function modeOf(path: string): number {
		return statSync(path).mode & 0o777;
	}

	it("creates global memory files and daily memory under the Morgan home", () => {
		const morganHomeDir = createTempDir();
		const context = loadAgentMemoryPromptContext({
			agentDir: join(morganHomeDir, "agent"),
			now: new Date(2026, 5, 1),
		});

		expect(context.morganHomeDir).toBe(morganHomeDir);
		expect(existsSync(join(morganHomeDir, "SOUL.md"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "IDENTITY.md"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "USER.md"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "memories", "daily", "2026-06-01.md"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "sessions"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "memory-index"))).toBe(true);
		expect(modeOf(morganHomeDir)).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "memories"))).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "memories", "daily"))).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "sessions"))).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "memory-index"))).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "SOUL.md"))).toBe(0o600);
		expect(modeOf(join(morganHomeDir, "IDENTITY.md"))).toBe(0o600);
		expect(modeOf(join(morganHomeDir, "USER.md"))).toBe(0o600);
		expect(modeOf(join(morganHomeDir, "MEMORY.md"))).toBe(0o600);
		expect(modeOf(join(morganHomeDir, "memories", "daily", "2026-06-01.md"))).toBe(0o600);
		expect(context.identitySection).toContain("## SOUL.md");
		expect(context.identitySection).toContain("## MEMORY.md");
	});

	it("truncates large injected identity files and retrieves matching daily excerpts", () => {
		const morganHomeDir = createTempDir();
		mkdirSync(join(morganHomeDir, "memories", "daily"), { recursive: true });
		writeFileSync(join(morganHomeDir, "MEMORY.md"), `# MEMORY.md\n\n${"durable fact\n".repeat(2000)}`);
		writeFileSync(
			join(morganHomeDir, "memories", "daily", "2026-05-31.md"),
			"# 2026-05-31\n\nThe user's phoenix project uses compact declarative memory notes.\n",
		);

		const context = loadAgentMemoryPromptContext({
			agentDir: join(morganHomeDir, "agent"),
			query: "What was decided about phoenix memory?",
			now: new Date(2026, 5, 1),
		});

		expect(context.identitySection).toContain("truncated injected copy");
		expect(context.retrievedSection).toContain("2026-05-31.md");
		expect(context.retrievedSection).toContain("phoenix project");
	});
});
