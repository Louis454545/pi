import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentMessage, uuidv7 } from "@earendil-works/morgan-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/morgan-ai";
import lockfile from "proper-lockfile";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { createCompactionSummaryMessage, createCustomMessage } from "./messages.ts";

export const CURRENT_SESSION_VERSION = 1;

export interface SessionHeader {
	type: "session";
	version: typeof CURRENT_SESSION_VERSION;
	id: string;
	timestamp: string;
	cwd: string;
}

export interface GlobalConversationOptions {
	cwd: string;
	sessionDir?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| CustomEntry
	| CustomMessageEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	"getCwd" | "getSessionId" | "getSessionFile" | "getEntries" | "getEntry" | "getBranch" | "getHeader"
>;

function getGlobalConversationDir(agentDir: string, sessionDir?: string): string {
	return join(getSessionsDir(agentDir, sessionDir), "global");
}

export function getDefaultSessionDir(_cwd: string, agentDir: string = getDefaultAgentDir()): string {
	return getGlobalConversationDir(agentDir);
}

export async function acquireGlobalConversationLock(
	agentDir: string = getDefaultAgentDir(),
	sessionDir?: string,
): Promise<() => Promise<void>> {
	const dir = getGlobalConversationDir(agentDir, sessionDir);
	mkdirSync(dir, { recursive: true });
	try {
		return await lockfile.lock(dir, {
			realpath: false,
			stale: 30000,
			retries: { retries: 5, factor: 1, minTimeout: 50, maxTimeout: 100, randomize: false },
		});
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code === "ELOCKED") {
			throw new Error("Global conversation is already open in another Morgan process.");
		}
		throw error;
	}
}

export function parseSessionEntries(content: string): FileEntry[] {
	if (!content.trim()) return [];
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FileEntry);
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	return parseSessionEntries(readFileSync(filePath, "utf-8"));
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction") return entry;
	}
	return null;
}

export function buildSessionContext(entries: SessionEntry[]): SessionContext {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;
	for (const entry of entries) {
		if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
		if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
		if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
		if (entry.type === "compaction") compaction = entry;
	}

	const messages: AgentMessage[] = [];
	const appendMessage = (entry: SessionEntry): void => {
		if (entry.type === "message") messages.push(entry.message);
		if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		}
	};
	if (!compaction) {
		for (const entry of entries) appendMessage(entry);
		return { messages, thinkingLevel, model };
	}

	messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
	const compactionIndex = entries.indexOf(compaction);
	const firstKeptIndex = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (firstKeptIndex >= 0) {
		for (let index = firstKeptIndex; index < compactionIndex; index++) appendMessage(entries[index]);
	}
	for (let index = compactionIndex + 1; index < entries.length; index++) appendMessage(entries[index]);
	return { messages, thinkingLevel, model };
}

function createHeader(cwd: string): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: uuidv7(),
		timestamp: new Date().toISOString(),
		cwd: resolvePath(cwd),
	};
}

export class SessionManager {
	private cwd: string;
	private sessionDir: string;
	private sessionFile: string | undefined;
	private persist: boolean;
	private fileEntries: FileEntry[];
	private byId = new Map<string, SessionEntry>();
	private leafId: string | null = null;

	private constructor(cwd: string, sessionDir: string, sessionFile: string | undefined, persist: boolean) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = sessionDir;
		this.sessionFile = sessionFile;
		this.persist = persist;
		if (sessionFile && existsSync(sessionFile)) {
			this.fileEntries = loadEntriesFromFile(sessionFile);
			const header = this.fileEntries[0];
			if (header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION) {
				throw new Error("Conversation file does not use the current Morgan session schema.");
			}
			if (resolvePath(header.cwd) !== this.cwd) {
				throw new Error("Conversation file working context does not match Morgan HOME.");
			}
		} else {
			this.fileEntries = [createHeader(this.cwd)];
			this.writeAll();
		}
		this.rebuildIndex();
	}

	private rebuildIndex(): void {
		this.byId.clear();
		this.leafId = null;
		for (const entry of this.getEntries()) {
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
		}
	}

	private writeAll(): void {
		if (!this.persist || !this.sessionFile) return;
		mkdirSync(dirname(this.sessionFile), { recursive: true });
		writeFileSync(
			this.sessionFile,
			`${this.fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"utf-8",
		);
	}

	private append(entry: SessionEntry): string {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		if (this.persist && this.sessionFile) appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		return entry.id;
	}

	private base(type: string): SessionEntryBase {
		return { type, id: uuidv7(), parentId: this.leafId, timestamp: new Date().toISOString() };
	}

	newSession(): void {
		this.fileEntries = [createHeader(this.cwd)];
		this.rebuildIndex();
		this.writeAll();
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	getSessionId(): string {
		return this.getHeader().id;
	}

	getHeader(): SessionHeader {
		return structuredClone(this.fileEntries[0] as SessionHeader);
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getEntries(): SessionEntry[] {
		return this.fileEntries.slice(1) as SessionEntry[];
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getBranch(): SessionEntry[] {
		return this.getEntries();
	}

	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries());
	}

	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		return this.append({ ...this.base("message"), type: "message", message });
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		return this.append({ ...this.base("thinking_level_change"), type: "thinking_level_change", thinkingLevel });
	}

	appendModelChange(provider: string, modelId: string): string {
		return this.append({ ...this.base("model_change"), type: "model_change", provider, modelId });
	}

	appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: T): string {
		return this.append({
			...this.base("compaction"),
			type: "compaction",
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
		});
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		return this.append({ ...this.base("custom"), type: "custom", customType, data });
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		return this.append({
			...this.base("custom_message"),
			type: "custom_message",
			customType,
			content,
			display,
			details,
		});
	}

	static inMemory(cwd: string = homedir()): SessionManager {
		return new SessionManager(cwd, "", undefined, false);
	}

	static openGlobal(agentDir: string = getDefaultAgentDir(), options: GlobalConversationOptions): SessionManager {
		const dir = options.sessionDir
			? join(normalizePath(options.sessionDir), "global")
			: getGlobalConversationDir(agentDir);
		return new SessionManager(options.cwd, dir, join(dir, "conversation.jsonl"), true);
	}
}
