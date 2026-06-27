import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	exportSessionToJsonl,
	SessionManager,
} from "../../src/core/session-manager.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
	tempDir = undefined;
});

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});
});

describe("SessionManager.openGlobal", () => {
	it("loads an existing canonical global conversation", () => {
		expect(CURRENT_SESSION_VERSION).toBe(3);
		tempDir = join(tmpdir(), `morgan-session-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(tempDir, "home");
		const sessionDir = join(tempDir, "sessions");
		const sessionFile = join(sessionDir, "global", "conversation.jsonl");
		const sessionId = "existing-global-session";
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			})}\n`,
			"utf-8",
		);

		const session = SessionManager.openGlobal(join(tempDir, "agent"), { cwd, sessionDir });

		expect(session.getSessionId()).toBe(sessionId);
		expect(session.getEntries()).toEqual([]);
	});
});

describe("exportSessionToJsonl", () => {
	it("exports the current branch as linear JSONL without runtime setup", () => {
		tempDir = join(tmpdir(), `morgan-session-export-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const session = SessionManager.inMemory(tempDir);
		const firstId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendCustomEntry("marker", { ok: true });
		const outputPath = join(tempDir, "exports", "session.jsonl");

		const writtenPath = exportSessionToJsonl(session, outputPath);
		const lines = readFileSync(writtenPath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; version?: number; parentId?: string | null; id?: string });

		expect(writtenPath).toBe(outputPath);
		expect(lines[0]).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION });
		expect(lines[1]).toMatchObject({ type: "message", parentId: null, id: firstId });
		expect(lines[2]).toMatchObject({ type: "custom", parentId: firstId });
	});
});
