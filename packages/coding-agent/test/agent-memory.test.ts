import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
		const tempDir = join(tmpdir(), `pi-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	it("creates global memory files and daily memory under the Pi home", () => {
		const piHomeDir = createTempDir();
		const context = loadAgentMemoryPromptContext({
			agentDir: join(piHomeDir, "agent"),
			now: new Date(2026, 5, 1),
		});

		expect(context.piHomeDir).toBe(piHomeDir);
		expect(existsSync(join(piHomeDir, "SOUL.md"))).toBe(true);
		expect(existsSync(join(piHomeDir, "IDENTITY.md"))).toBe(true);
		expect(existsSync(join(piHomeDir, "USER.md"))).toBe(true);
		expect(existsSync(join(piHomeDir, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(piHomeDir, "memories", "daily", "2026-06-01.md"))).toBe(true);
		expect(existsSync(join(piHomeDir, "sessions"))).toBe(true);
		expect(existsSync(join(piHomeDir, "memory-index"))).toBe(true);
		expect(context.identitySection).toContain("## SOUL.md");
		expect(context.identitySection).toContain("## MEMORY.md");
	});

	it("truncates large injected identity files and retrieves matching daily excerpts", () => {
		const piHomeDir = createTempDir();
		mkdirSync(join(piHomeDir, "memories", "daily"), { recursive: true });
		writeFileSync(join(piHomeDir, "MEMORY.md"), `# MEMORY.md\n\n${"durable fact\n".repeat(2000)}`);
		writeFileSync(
			join(piHomeDir, "memories", "daily", "2026-05-31.md"),
			"# 2026-05-31\n\nThe user's phoenix project uses compact declarative memory notes.\n",
		);

		const context = loadAgentMemoryPromptContext({
			agentDir: join(piHomeDir, "agent"),
			query: "What was decided about phoenix memory?",
			now: new Date(2026, 5, 1),
		});

		expect(context.identitySection).toContain("truncated injected copy");
		expect(context.retrievedSection).toContain("2026-05-31.md");
		expect(context.retrievedSection).toContain("phoenix project");
	});
});
