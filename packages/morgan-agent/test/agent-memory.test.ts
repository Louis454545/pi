import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

	it("creates only the durable snapshot under the Morgan memory directory", () => {
		const morganHomeDir = createTempDir();
		const context = loadAgentMemoryPromptContext({
			agentDir: join(morganHomeDir, "agent"),
			now: new Date(2026, 5, 1),
		});

		expect(context.morganHomeDir).toBe(morganHomeDir);
		expect(context.memoryDir).toBe(join(morganHomeDir, "memory"));
		expect(context.snapshotPath).toBe(join(morganHomeDir, "memory", "snapshot.md"));
		expect(readdirSync(context.memoryDir).sort()).toEqual(["snapshot.md"]);
		expect(existsSync(join(morganHomeDir, "memory", "recent.md"))).toBe(false);
		expect(existsSync(join(morganHomeDir, "memory", "events"))).toBe(false);
		expect(existsSync(join(morganHomeDir, "memory", "curator-errors.log"))).toBe(false);
		expect(modeOf(morganHomeDir)).toBe(0o700);
		expect(modeOf(context.memoryDir)).toBe(0o700);
		expect(modeOf(context.snapshotPath)).toBe(0o600);
		expect(context.promptSection).toContain("# Curated Memory Context");
		expect(context.promptSection).toContain("# User Bio");
		expect(context.promptSection).toContain("# User Interaction Metadata");
		expect(context.promptSection).toContain("# User Knowledge Memories");
		expect(context.promptSection).not.toContain("Recent Conversation Content");
	});

	it("loads snapshot content into the prompt section", () => {
		const morganHomeDir = createTempDir();
		const memoryDir = join(morganHomeDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		const snapshotPath = join(memoryDir, "snapshot.md");
		writeFileSync(
			snapshotPath,
			"# User Bio\n\n- The user prefers concise technical English.\n\n# User Interaction Metadata\n\n- (none)\n\n# User Knowledge Memories\n\n- Preference: concise technical English.\n",
		);

		const context = loadAgentMemoryPromptContext({ agentDir: join(morganHomeDir, "agent") });

		expect(readFileSync(context.snapshotPath, "utf-8")).toContain("concise technical English");
		expect(context.promptSection).toContain("concise technical English");
	});

	it("rejects a memory snapshot symlink", () => {
		const morganHomeDir = createTempDir();
		const memoryDir = join(morganHomeDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		const outsidePath = join(morganHomeDir, "outside.md");
		writeFileSync(outsidePath, "# Outside\n");
		symlinkSync(outsidePath, join(memoryDir, "snapshot.md"));

		expect(() => loadAgentMemoryPromptContext({ agentDir: join(morganHomeDir, "agent") })).toThrow(
			"snapshot.md must be a regular file",
		);
	});
});
