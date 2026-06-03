import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { type FileEntry, migrateSessionEntries, SessionManager } from "../../src/core/session-manager.ts";

describe("migrateSessionEntries", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	function createTempDir(): string {
		const tempDir = join(tmpdir(), `morgan-session-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set (v3 is current after hookMessage->custom migration)
		expect((entries[0] as any).version).toBe(3);

		// Entries should have id/parentId
		const msg1 = entries[1] as any;
		const msg2 = entries[2] as any;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect((entries[1] as any).id).toBe("abc12345");
		expect((entries[2] as any).id).toBe("def67890");
		expect((entries[2] as any).parentId).toBe("abc12345");
	});

	it("migrates the old default agent/sessions tree before continuing recent sessions", () => {
		const morganHomeDir = createTempDir();
		const agentDir = join(morganHomeDir, "agent");
		const cwd = join(morganHomeDir, "project");
		mkdirSync(cwd, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const legacySessionDir = join(agentDir, "sessions", safePath);
		const newSessionDir = join(morganHomeDir, "sessions", safePath);
		const fileName = "2026-06-02T00-00-00-000Z_legacy.jsonl";
		const legacySessionFile = join(legacySessionDir, fileName);
		mkdirSync(legacySessionDir, { recursive: true });
		writeFileSync(
			legacySessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2026-06-02T00:00:00.000Z", cwd })}\n`,
		);

		const manager = SessionManager.continueRecent(cwd);

		expect(manager.getSessionDir()).toBe(newSessionDir);
		expect(manager.getSessionFile()).toBe(join(newSessionDir, basename(legacySessionFile)));
		expect(existsSync(join(newSessionDir, fileName))).toBe(true);
		expect(existsSync(legacySessionFile)).toBe(false);
	});

	it("migrates the old default agent/sessions root before listing all sessions", async () => {
		const morganHomeDir = createTempDir();
		const agentDir = join(morganHomeDir, "agent");
		const cwd = join(morganHomeDir, "project");
		mkdirSync(cwd, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const legacySessionDir = join(agentDir, "sessions", safePath);
		const newSessionDir = join(morganHomeDir, "sessions", safePath);
		const fileName = "2026-06-02T00-00-00-000Z_legacy.jsonl";
		const legacySessionFile = join(legacySessionDir, fileName);
		mkdirSync(legacySessionDir, { recursive: true });
		writeFileSync(
			legacySessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2026-06-02T00:00:00.000Z", cwd })}\n`,
		);

		const sessions = await SessionManager.listAll();

		expect(sessions.map((session) => session.path)).toEqual([join(newSessionDir, basename(legacySessionFile))]);
		expect(existsSync(join(newSessionDir, fileName))).toBe(true);
		expect(existsSync(legacySessionFile)).toBe(false);
	});

	it("merges old default session files when the new default cwd directory already exists", async () => {
		const morganHomeDir = createTempDir();
		const agentDir = join(morganHomeDir, "agent");
		const cwd = join(morganHomeDir, "project");
		mkdirSync(cwd, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const legacySessionDir = join(agentDir, "sessions", safePath);
		const newSessionDir = join(morganHomeDir, "sessions", safePath);
		const legacyFileName = "2026-06-02T00-00-00-000Z_legacy.jsonl";
		const existingFileName = "2026-06-02T00-01-00-000Z_existing.jsonl";
		const legacySessionFile = join(legacySessionDir, legacyFileName);
		mkdirSync(legacySessionDir, { recursive: true });
		mkdirSync(newSessionDir, { recursive: true });
		writeFileSync(
			legacySessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2026-06-02T00:00:00.000Z", cwd })}\n`,
		);
		writeFileSync(
			join(newSessionDir, existingFileName),
			`${JSON.stringify({ type: "session", version: 3, id: "existing", timestamp: "2026-06-02T00:01:00.000Z", cwd })}\n`,
		);

		const sessions = await SessionManager.listAll();

		expect(sessions.map((session) => basename(session.path)).sort()).toEqual([legacyFileName, existingFileName]);
		expect(existsSync(join(newSessionDir, legacyFileName))).toBe(true);
		expect(existsSync(legacySessionFile)).toBe(false);
	});
});
