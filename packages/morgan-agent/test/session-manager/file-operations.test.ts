import { constants as bufferConstants } from "buffer";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireGlobalConversationLock,
	findMostRecentSession,
	getGlobalConversationArchiveDir,
	getGlobalConversationFile,
	loadEntriesFromFile,
	SessionManager,
} from "../../src/core/session-manager.ts";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});

	it("opens session files larger than Node's max string length", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		const fd = openSync(file, "r+");
		try {
			const newline = Buffer.from("\n");
			const stride = 16 * 1024 * 1024;
			for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
				writeSync(fd, newline, 0, newline.length, offset);
			}
		} finally {
			closeSync(fd);
		}

		appendFileSync(
			file,
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe("abc");
		expect(sessionManager.getEntries()).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(cwd: string, label: string): string {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
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
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});
});

describe("SessionManager global conversation", () => {
	let tempDir: string;
	let agentDir: string;
	let sessionDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `global-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		sessionDir = join(tempDir, "sessions");
		cwd = join(tempDir, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeLegacySession(relativePath: string, id: string, content: string): string {
		const filePath = join(sessionDir, relativePath);
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(
			filePath,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd })}\n` +
				`${JSON.stringify({ type: "message", id: `${id}-msg`, parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content, timestamp: 1 } })}\n`,
		);
		return filePath;
	}

	it("creates the canonical global conversation file", () => {
		const sessionManager = SessionManager.openGlobal(agentDir, { cwd, sessionDir });
		const canonicalFile = getGlobalConversationFile(agentDir, sessionDir);

		expect(sessionManager.getSessionFile()).toBe(canonicalFile);
		expect(existsSync(canonicalFile)).toBe(true);
		expect(loadEntriesFromFile(canonicalFile)[0]).toMatchObject({ type: "session", cwd });
	});

	it("imports the most recent legacy session on first global open", async () => {
		const older = writeLegacySession("old/older.jsonl", "old", "older message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const newer = writeLegacySession("new/newer.jsonl", "new", "newer message");

		expect(SessionManager.findMostRecentLegacySession(agentDir, sessionDir)).toBe(newer);

		const sessionManager = SessionManager.openGlobal(agentDir, { cwd, sessionDir });
		const canonicalFile = getGlobalConversationFile(agentDir, sessionDir);
		const entries = loadEntriesFromFile(canonicalFile);

		expect(sessionManager.getSessionFile()).toBe(canonicalFile);
		expect((entries[0] as { parentSession?: string }).parentSession).toBe(newer);
		expect(JSON.stringify(entries)).toContain("newer message");
		expect(JSON.stringify(entries)).not.toContain("older message");
		expect(existsSync(older)).toBe(true);
		expect(existsSync(newer)).toBe(true);
	});

	it("ignores corrupt legacy session files on first global open", async () => {
		const valid = writeLegacySession("valid/valid.jsonl", "valid", "valid message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const corrupt = join(sessionDir, "corrupt/corrupt.jsonl");
		mkdirSync(join(corrupt, ".."), { recursive: true });
		writeFileSync(
			corrupt,
			`${JSON.stringify({ type: "session", version: 3, id: "corrupt", timestamp: "2025-01-01T00:00:00.000Z", cwd })}\n` +
				"not valid json\n" +
				`${JSON.stringify({ type: "message", id: "corrupt-msg", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "corrupt message", timestamp: 1 } })}\n`,
		);

		expect(SessionManager.findMostRecentLegacySession(agentDir, sessionDir)).toBe(valid);

		SessionManager.openGlobal(agentDir, { cwd, sessionDir });
		const entries = loadEntriesFromFile(getGlobalConversationFile(agentDir, sessionDir));

		expect((entries[0] as { parentSession?: string }).parentSession).toBe(valid);
		expect(JSON.stringify(entries)).toContain("valid message");
		expect(JSON.stringify(entries)).not.toContain("corrupt message");
	});

	it("ignores canonical and archived global files when finding legacy sessions", async () => {
		const legacy = writeLegacySession("project/session.jsonl", "legacy", "legacy message");
		const canonicalFile = getGlobalConversationFile(agentDir, sessionDir);
		const archiveFile = join(getGlobalConversationArchiveDir(agentDir, sessionDir), "archived.jsonl");
		mkdirSync(join(canonicalFile, ".."), { recursive: true });
		mkdirSync(join(archiveFile, ".."), { recursive: true });
		await new Promise((resolve) => setTimeout(resolve, 10));
		writeLegacySession("global/conversation.jsonl", "canonical", "canonical message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		writeLegacySession("global/archive/archived.jsonl", "archive", "archive message");

		expect(SessionManager.findMostRecentLegacySession(agentDir, sessionDir)).toBe(legacy);
	});

	it("archives the current canonical file when resetting", () => {
		const first = SessionManager.openGlobal(agentDir, { cwd, sessionDir });
		first.appendMessage({ role: "user", content: "before reset", timestamp: 1 });

		const reset = SessionManager.resetGlobal(agentDir, {
			cwd,
			sessionDir,
			parentSession: first.getSessionFile(),
		});
		const canonicalFile = getGlobalConversationFile(agentDir, sessionDir);
		const archiveDir = getGlobalConversationArchiveDir(agentDir, sessionDir);
		const archiveFiles = readdirSync(archiveDir).filter((name) => name.endsWith(".jsonl"));
		const entries = loadEntriesFromFile(canonicalFile);

		expect(reset.getSessionFile()).toBe(canonicalFile);
		expect(archiveFiles).toHaveLength(1);
		expect(JSON.stringify(loadEntriesFromFile(join(archiveDir, archiveFiles[0])))).toContain("before reset");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "session", parentSession: first.getSessionFile() });
	});

	it("archives the current canonical file when importing", () => {
		const first = SessionManager.openGlobal(agentDir, { cwd, sessionDir });
		first.appendMessage({ role: "user", content: "before import", timestamp: 1 });
		const imported = writeLegacySession("import/import.jsonl", "imported", "imported message");

		const sessionManager = SessionManager.importGlobal(agentDir, imported, { cwd, sessionDir });
		const canonicalFile = getGlobalConversationFile(agentDir, sessionDir);
		const archiveFiles = readdirSync(getGlobalConversationArchiveDir(agentDir, sessionDir)).filter((name) =>
			name.endsWith(".jsonl"),
		);
		const entries = loadEntriesFromFile(canonicalFile);

		expect(sessionManager.getSessionFile()).toBe(canonicalFile);
		expect(archiveFiles).toHaveLength(1);
		expect((entries[0] as { parentSession?: string }).parentSession).toBe(imported);
		expect(JSON.stringify(entries)).toContain("imported message");
	});

	it("rejects corrupt explicit imports without archiving the current canonical file", () => {
		const first = SessionManager.openGlobal(agentDir, { cwd, sessionDir });
		first.appendMessage({ role: "user", content: "before corrupt import", timestamp: 1 });
		const corrupt = join(sessionDir, "import/corrupt.jsonl");
		mkdirSync(join(corrupt, ".."), { recursive: true });
		writeFileSync(
			corrupt,
			`${JSON.stringify({ type: "session", version: 3, id: "corrupt", timestamp: "2025-01-01T00:00:00.000Z", cwd })}\n` +
				"not valid json\n",
		);

		expect(() => SessionManager.importGlobal(agentDir, corrupt, { cwd, sessionDir })).toThrow(
			"Cannot import invalid session file",
		);

		expect(JSON.stringify(loadEntriesFromFile(getGlobalConversationFile(agentDir, sessionDir)))).toContain(
			"before corrupt import",
		);
		expect(existsSync(getGlobalConversationArchiveDir(agentDir, sessionDir))).toBe(false);
	});

	it("locks the canonical global conversation directory", async () => {
		const release = await acquireGlobalConversationLock(agentDir, sessionDir);
		try {
			await expect(acquireGlobalConversationLock(agentDir, sessionDir)).rejects.toThrow(
				"Global conversation is already open in another morgan process",
			);
		} finally {
			await release();
		}

		const releaseAgain = await acquireGlobalConversationLock(agentDir, sessionDir);
		await releaseAgain();
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("truncates and rewrites file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		// File with messages but no session header (corrupted state)
		writeFileSync(
			noHeaderFile,
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n',
		);

		const sm = SessionManager.open(noHeaderFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain only a valid header (old content truncated)
		const content = readFileSync(noHeaderFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of recovered file work correctly", () => {
		const corruptedFile = join(tempDir, "corrupted.jsonl");
		writeFileSync(corruptedFile, "garbage content\n");

		// First open recovers the file
		const sm1 = SessionManager.open(corruptedFile, tempDir);
		const sessionId = sm1.getSessionId();

		// Second open should load the recovered file successfully
		const sm2 = SessionManager.open(corruptedFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});
