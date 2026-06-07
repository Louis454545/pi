import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel as AgentThinkingLevel } from "@earendil-works/morgan-agent-core";
import type {
	Api,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingLevel,
	ToolCall,
} from "@earendil-works/morgan-ai";
import { completeSimple } from "@earendil-works/morgan-ai";
import { getMorganHomeDir } from "../config.ts";

const MEMORY_DIR_NAME = "memory";
const SNAPSHOT_FILE_NAME = "snapshot.md";
const RECENT_FILE_NAME = "recent.md";
const EVENTS_DIR_NAME = "events";
const CURATOR_ERRORS_FILE_NAME = "curator-errors.log";
const MAX_MEMORY_PROMPT_CHARS = 18000;
const MAX_RECENT_PROMPT_CHARS = 10000;
const MAX_TRANSCRIPT_CHARS = 16000;
const MAX_CURATOR_OUTPUT_CHARS = 40000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const MEMORY_SECTION_HEADINGS = [
	"# User Bio",
	"# Recent Conversation Content",
	"# User Interaction Metadata",
	"# User Knowledge Memories",
] as const;

export interface AgentMemoryPromptContext {
	morganHomeDir: string;
	memoryDir: string;
	snapshotPath: string;
	recentPath: string;
	promptSection: string;
}

export interface MemoryStorePaths {
	morganHomeDir: string;
	memoryDir: string;
	snapshotPath: string;
	recentPath: string;
	eventsDir: string;
	curatorErrorsPath: string;
}

export interface MemoryTurnRecord {
	sessionId?: string;
	timestamp: string;
	transcript: string;
}

export interface CurateAgentMemoryOptions {
	agentDir?: string;
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	thinkingLevel?: AgentThinkingLevel;
	messages: AgentMessage[];
	sessionId?: string;
	now?: Date;
	complete?: (context: Context, options: SimpleStreamOptions) => Promise<string>;
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function chmodPrivate(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Ignore platforms or filesystems that do not support POSIX modes.
	}
}

function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	chmodPrivate(path, PRIVATE_DIR_MODE);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function ensureFile(path: string, content: string): void {
	if (!existsSync(path)) {
		try {
			writeFileSync(path, content, { flag: "wx", mode: PRIVATE_FILE_MODE });
		} catch (error) {
			if (!isErrnoException(error) || error.code !== "EEXIST") {
				throw error;
			}
		}
	}
	chmodPrivate(path, PRIVATE_FILE_MODE);
}

function readTextFile(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function writePrivateFileAtomic(path: string, content: string): void {
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, content, { mode: PRIVATE_FILE_MODE });
	chmodPrivate(tempPath, PRIVATE_FILE_MODE);
	renameSync(tempPath, path);
	chmodPrivate(path, PRIVATE_FILE_MODE);
}

function truncateForPrompt(content: string, maxChars: number): string {
	if (content.length <= maxChars) {
		return content.trimEnd();
	}

	const clipped = content.slice(0, maxChars);
	const lastNewline = clipped.lastIndexOf("\n");
	const safeEnd = lastNewline > Math.floor(maxChars * 0.75) ? lastNewline : maxChars;
	const truncatedChars = content.length - safeEnd;
	return `${content.slice(0, safeEnd).trimEnd()}\n\n[Memory context truncated by ${truncatedChars} characters.]`;
}

function defaultSnapshotContent(now: Date): string {
	return [
		"# User Bio",
		"",
		"- (none)",
		"",
		"# Recent Conversation Content",
		"",
		"- (none)",
		"",
		"# User Interaction Metadata",
		"",
		`- Memory snapshot initialized at ${now.toISOString()}.`,
		"",
		"# User Knowledge Memories",
		"",
		"- (none)",
		"",
	].join("\n");
}

function defaultRecentContent(now: Date): string {
	return [
		"# Recent Conversation Content",
		"",
		`Memory curator initialized this recent-conversation scratchpad at ${now.toISOString()}.`,
		"",
	].join("\n");
}

function ensureMemoryStore(agentDir: string | undefined, now: Date): MemoryStorePaths {
	const morganHomeDir = getMorganHomeDir(agentDir);
	const memoryDir = join(morganHomeDir, MEMORY_DIR_NAME);
	const eventsDir = join(memoryDir, EVENTS_DIR_NAME);
	const snapshotPath = join(memoryDir, SNAPSHOT_FILE_NAME);
	const recentPath = join(memoryDir, RECENT_FILE_NAME);
	const curatorErrorsPath = join(memoryDir, CURATOR_ERRORS_FILE_NAME);

	ensurePrivateDir(morganHomeDir);
	ensurePrivateDir(memoryDir);
	ensurePrivateDir(eventsDir);
	ensureFile(snapshotPath, defaultSnapshotContent(now));
	ensureFile(recentPath, defaultRecentContent(now));
	ensureFile(curatorErrorsPath, "");

	return { morganHomeDir, memoryDir, snapshotPath, recentPath, eventsDir, curatorErrorsPath };
}

function formatPromptSection(paths: MemoryStorePaths): string {
	const snapshot = truncateForPrompt(readTextFile(paths.snapshotPath), MAX_MEMORY_PROMPT_CHARS);
	const recent = truncateForPrompt(readTextFile(paths.recentPath), MAX_RECENT_PROMPT_CHARS);
	const lines = [
		"# Curated Memory Context",
		"",
		`Morgan memory directory: ${paths.memoryDir}`,
		`Curated memory snapshot: ${paths.snapshotPath}`,
		`Recent conversation scratchpad: ${paths.recentPath}`,
		"",
		"Morgan's memory is maintained by a separate memory curator after conversations. Treat this context as read-only: use it when relevant, but do not decide what to save and do not edit memory files unless explicitly asked to inspect or repair the memory system itself.",
		"",
		snapshot,
	];
	if (recent.trim().length > 0) {
		lines.push("", "## Curator Recent Scratchpad", "", recent);
	}
	return lines.join("\n").trimEnd();
}

export function loadAgentMemoryPromptContext(
	options: { agentDir?: string; query?: string; now?: Date } = {},
): AgentMemoryPromptContext {
	const now = options.now ?? new Date();
	const paths = ensureMemoryStore(options.agentDir, now);
	return {
		morganHomeDir: paths.morganHomeDir,
		memoryDir: paths.memoryDir,
		snapshotPath: paths.snapshotPath,
		recentPath: paths.recentPath,
		promptSection: formatPromptSection(paths),
	};
}

function textContentFromParts(content: Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}

	const text: string[] = [];
	for (const part of content) {
		if (part.type === "text") {
			text.push((part as TextContent).text);
		} else if (part.type === "image") {
			const image = part as ImageContent;
			text.push(`[image: ${image.mimeType}]`);
		} else if (part.type === "thinking") {
			text.push("[assistant thinking omitted]");
		} else if (part.type === "toolCall") {
			const toolCall = part as ToolCall;
			text.push(`[tool call: ${toolCall.name} ${JSON.stringify(toolCall.arguments)}]`);
		}
	}
	return text.join("\n").trim();
}

function roleLabel(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "user":
			return "User";
		case "assistant":
			return "Assistant";
		case "toolResult":
			return "Tool Result";
		case "custom":
			return `Custom ${message.customType}`;
		case "bashExecution":
			return "Bash Execution";
		case "compactionSummary":
			return "Compaction Summary";
		case "branchSummary":
			return "Branch Summary";
	}
}

function textFromAgentMessage(message: AgentMessage): string {
	if (message.role === "bashExecution") {
		const status = message.cancelled ? "cancelled" : `exit ${message.exitCode}`;
		return `$ ${message.command}\n[${status}]\n${message.output}`;
	}
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		return message.summary;
	}
	return textContentFromParts(message.content);
}

export function formatMemoryTranscript(messages: AgentMessage[], maxChars = MAX_TRANSCRIPT_CHARS): string {
	const relevantMessages = messages
		.filter((message) => message.role !== "toolResult" || textFromAgentMessage(message).trim().length > 0)
		.slice(-16);
	const lines: string[] = [];

	for (const message of relevantMessages) {
		const label = roleLabel(message);
		if (!label) {
			continue;
		}
		const text = textFromAgentMessage(message).trim();
		if (text.length === 0) {
			continue;
		}
		lines.push(`${label}: ${text}`);
	}

	return truncateForPrompt(lines.join("\n\n"), maxChars);
}

function appendMemoryTurn(paths: MemoryStorePaths, record: MemoryTurnRecord, now: Date): void {
	const eventPath = join(paths.eventsDir, `${formatLocalDate(now)}.jsonl`);
	const line = JSON.stringify(record);
	writeFileSync(eventPath, `${line}\n`, { flag: "a", mode: PRIVATE_FILE_MODE });
	chmodPrivate(eventPath, PRIVATE_FILE_MODE);
}

function appendCuratorError(paths: MemoryStorePaths, error: unknown, now: Date): void {
	const message = error instanceof Error ? error.stack || error.message : String(error);
	writeFileSync(paths.curatorErrorsPath, `[${now.toISOString()}] ${message}\n`, {
		flag: "a",
		mode: PRIVATE_FILE_MODE,
	});
	chmodPrivate(paths.curatorErrorsPath, PRIVATE_FILE_MODE);
}

function normalizeCuratorMarkdown(content: string, now: Date): string {
	const trimmed = content
		.replace(/^```(?:markdown)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	const candidate = trimmed.length > 0 ? trimmed : defaultSnapshotContent(now).trim();
	const lines = candidate.split(/\r?\n/);
	const firstHeadingIndex = lines.findIndex((line) => isMemorySectionHeading(line.trim()));
	const normalized = firstHeadingIndex > 0 ? lines.slice(firstHeadingIndex).join("\n").trim() : candidate;

	const normalizedHeadings = new Set(
		normalized
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(isMemorySectionHeading),
	);
	const missing = MEMORY_SECTION_HEADINGS.filter((heading) => !normalizedHeadings.has(heading));
	if (missing.length === 0) {
		return `${normalized.slice(0, MAX_CURATOR_OUTPUT_CHARS).trimEnd()}\n`;
	}

	return `${normalizeSnapshotSections(normalized).slice(0, MAX_CURATOR_OUTPUT_CHARS).trimEnd()}\n`;
}

function normalizeSnapshotSections(content: string): string {
	const sectionTexts = new Map<string, string>();
	const lines = content.split(/\r?\n/);
	let currentHeading: string | undefined;
	let currentLines: string[] = [];

	for (const line of lines) {
		const heading = MEMORY_SECTION_HEADINGS.find((candidate) => line.trim() === candidate);
		if (heading) {
			if (currentHeading) {
				sectionTexts.set(currentHeading, currentLines.join("\n").trim());
			}
			currentHeading = heading;
			currentLines = [];
			continue;
		}
		if (currentHeading) {
			currentLines.push(line);
		}
	}
	if (currentHeading) {
		sectionTexts.set(currentHeading, currentLines.join("\n").trim());
	}

	return MEMORY_SECTION_HEADINGS.map((heading) => {
		const body = sectionTexts.get(heading);
		return [heading, "", body && body.length > 0 ? body : "- (none)"].join("\n");
	}).join("\n\n");
}

function isMemorySectionHeading(value: string): value is (typeof MEMORY_SECTION_HEADINGS)[number] {
	return MEMORY_SECTION_HEADINGS.some((heading) => heading === value);
}

function formatCuratorSystemPrompt(now: Date): string {
	return `You are Morgan's separate memory curator. You are not the main agent and you do not solve the user's task.

Rewrite Morgan's memory from the previous snapshot and the latest transcript. Output one complete Markdown snapshot only.

Memory goals:
- Carry forward useful context about the user, their projects, preferences, constraints, relationships, recurring workflows, and durable goals.
- Follow preferences and constraints by making them easy for the main agent to apply in future conversations.
- Stay current over time: replace stale time-sensitive claims with dated history, remove expired plans, and preserve corrections over older claims.
- Prefer specific, compact, declarative facts. Include dates for facts that can expire.
- Do not save raw logs, temporary task progress, one-off debugging details, large code blocks, secrets, credentials, or instructions that belong in a skill.
- The main agent must not decide what to save; you own memory synthesis.

Use this exact section order:

# User Bio

# Recent Conversation Content

# User Interaction Metadata

# User Knowledge Memories

Current timestamp: ${now.toISOString()}`;
}

function formatCuratorUserPrompt(previousSnapshot: string, previousRecent: string, transcript: string): string {
	return [
		"<previous-memory-snapshot>",
		previousSnapshot.trim() || "(empty)",
		"</previous-memory-snapshot>",
		"",
		"<previous-recent-conversation-content>",
		previousRecent.trim() || "(empty)",
		"</previous-recent-conversation-content>",
		"",
		"<latest-transcript>",
		transcript.trim() || "(empty)",
		"</latest-transcript>",
		"",
		"Return the full updated memory snapshot as Markdown. Do not include analysis, JSON, XML, or commentary.",
	].join("\n");
}

function toProviderThinkingLevel(level: AgentThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === "off" ? undefined : level;
}

function extractRecentSection(snapshot: string): string {
	const start = snapshot.indexOf("# Recent Conversation Content");
	if (start === -1) {
		return "";
	}
	const rest = snapshot.slice(start);
	const nextHeading = rest.slice(1).search(/\n# /);
	return nextHeading === -1 ? rest.trimEnd() : rest.slice(0, nextHeading + 1).trimEnd();
}

function shouldSkipCuratorForModel(model: Model<Api>): boolean {
	if (/^(0|false|off|no)$/i.test(process.env.MORGAN_MEMORY_CURATOR ?? "")) {
		return true;
	}
	return model.provider === "faux";
}

export async function curateAgentMemory(options: CurateAgentMemoryOptions): Promise<void> {
	const now = options.now ?? new Date();
	const paths = ensureMemoryStore(options.agentDir, now);
	const transcript = formatMemoryTranscript(options.messages);
	if (transcript.length === 0) {
		return;
	}

	appendMemoryTurn(
		paths,
		{
			sessionId: options.sessionId,
			timestamp: now.toISOString(),
			transcript,
		},
		now,
	);

	if (shouldSkipCuratorForModel(options.model) && !options.complete) {
		return;
	}

	try {
		const previousSnapshot = readTextFile(paths.snapshotPath);
		const previousRecent = readTextFile(paths.recentPath);
		const context: Context = {
			systemPrompt: formatCuratorSystemPrompt(now),
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: formatCuratorUserPrompt(previousSnapshot, previousRecent, transcript) }],
					timestamp: now.getTime(),
				},
			],
		};
		const streamOptions: SimpleStreamOptions = {
			apiKey: options.apiKey,
			headers: options.headers,
			reasoning: toProviderThinkingLevel(options.thinkingLevel),
			maxTokens: 4096,
		};
		let output: string;
		if (options.complete !== undefined) {
			output = await options.complete(context, streamOptions);
		} else {
			const message = await completeSimple(options.model, context, streamOptions);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage || `Memory curator stopped with reason: ${message.stopReason}`);
			}
			output = textContentFromParts(message.content);
		}
		const normalizedSnapshot = normalizeCuratorMarkdown(output, now);
		writePrivateFileAtomic(paths.snapshotPath, normalizedSnapshot);
		writePrivateFileAtomic(paths.recentPath, `${extractRecentSection(normalizedSnapshot)}\n`);
	} catch (error) {
		appendCuratorError(paths, error, now);
	}
}
