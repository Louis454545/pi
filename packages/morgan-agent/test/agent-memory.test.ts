import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/morgan-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/morgan-ai";
import { afterEach, describe, expect, it } from "vitest";
import { curateAgentMemory, loadAgentMemoryPromptContext } from "../src/core/agent-memory.ts";

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

	const model: Model<Api> = {
		id: "faux-memory",
		name: "Faux Memory",
		api: "faux",
		provider: "faux",
		baseUrl: "https://faux.local",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	it("creates the curated memory store under the Morgan home", () => {
		const morganHomeDir = createTempDir();
		const context = loadAgentMemoryPromptContext({
			agentDir: join(morganHomeDir, "agent"),
			now: new Date(2026, 5, 1),
		});

		expect(context.morganHomeDir).toBe(morganHomeDir);
		expect(context.memoryDir).toBe(join(morganHomeDir, "memory"));
		expect(existsSync(join(morganHomeDir, "memory", "snapshot.md"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "memory", "recent.md"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "memory", "events"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "memory", "curator-errors.log"))).toBe(true);
		expect(existsSync(join(morganHomeDir, "SOUL.md"))).toBe(false);
		expect(existsSync(join(morganHomeDir, "MEMORY.md"))).toBe(false);
		expect(existsSync(join(morganHomeDir, "memory-index"))).toBe(false);
		expect(modeOf(morganHomeDir)).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "memory"))).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "memory", "events"))).toBe(0o700);
		expect(modeOf(join(morganHomeDir, "memory", "snapshot.md"))).toBe(0o600);
		expect(context.promptSection).toContain("# Curated Memory Context");
		expect(context.promptSection).toContain("# User Bio");
		expect(context.promptSection).toContain("# User Knowledge Memories");
	});

	it("lets the separate curator rewrite the snapshot from recent transcript", async () => {
		const morganHomeDir = createTempDir();
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Remember that I prefer concise technical English." }],
				timestamp: new Date(2026, 5, 1, 10).getTime(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Noted." }],
				api: "faux",
				provider: "faux",
				model: "faux-memory",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: new Date(2026, 5, 1, 10, 1).getTime(),
			},
		];
		let curatorContext: Context | undefined;
		const complete = async (context: Context, _options: SimpleStreamOptions): Promise<string> => {
			curatorContext = context;
			return [
				"# User Bio",
				"",
				"- The user prefers concise technical English.",
				"",
				"# Recent Conversation Content",
				"",
				"- 2026-06-01: The user asked Morgan to remember a concise technical English preference.",
				"",
				"# User Interaction Metadata",
				"",
				"- Preferred response style: concise technical English.",
				"",
				"# User Knowledge Memories",
				"",
				"- The user prefers concise technical English.",
				"",
			].join("\n");
		};

		await curateAgentMemory({
			agentDir: join(morganHomeDir, "agent"),
			model,
			messages,
			sessionId: "session-test",
			now: new Date(2026, 5, 1, 10, 2),
			complete,
		});

		const snapshot = readFileSync(join(morganHomeDir, "memory", "snapshot.md"), "utf-8");
		const recent = readFileSync(join(morganHomeDir, "memory", "recent.md"), "utf-8");
		const events = readFileSync(join(morganHomeDir, "memory", "events", "2026-06-01.jsonl"), "utf-8");
		expect(curatorContext?.systemPrompt).toContain("separate memory curator");
		expect(curatorContext?.messages[0].role).toBe("user");
		expect(snapshot).toContain("concise technical English");
		expect(recent).toContain("# Recent Conversation Content");
		expect(recent).toContain("2026-06-01");
		expect(events).toContain("session-test");
		expect(events).toContain("Remember that I prefer concise technical English.");
	});
});
