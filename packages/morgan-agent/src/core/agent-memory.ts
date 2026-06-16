import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMorganHomeDir } from "../config.ts";

export const MEMORY_DIR_NAME = "memory";
export const SNAPSHOT_FILE_NAME = "snapshot.md";

const MAX_MEMORY_PROMPT_CHARS = 18000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface AgentMemoryPromptContext {
	morganHomeDir: string;
	memoryDir: string;
	snapshotPath: string;
	promptSection: string;
}

export interface MemoryStorePaths {
	morganHomeDir: string;
	memoryDir: string;
	snapshotPath: string;
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
	const stat = lstatSync(path);
	if (!stat.isFile()) {
		throw new Error(`${path} must be a regular file.`);
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

export function ensureMemoryStore(agentDir: string | undefined, now: Date = new Date()): MemoryStorePaths {
	const morganHomeDir = getMorganHomeDir(agentDir);
	const memoryDir = join(morganHomeDir, MEMORY_DIR_NAME);
	const snapshotPath = join(memoryDir, SNAPSHOT_FILE_NAME);

	ensurePrivateDir(morganHomeDir);
	ensurePrivateDir(memoryDir);
	ensureFile(snapshotPath, defaultSnapshotContent(now));

	return { morganHomeDir, memoryDir, snapshotPath };
}

function formatPromptSection(paths: MemoryStorePaths): string {
	const snapshot = truncateForPrompt(readTextFile(paths.snapshotPath), MAX_MEMORY_PROMPT_CHARS);
	return [
		"# Curated Memory Context",
		"",
		`Morgan memory directory: ${paths.memoryDir}`,
		`Durable memory snapshot: ${paths.snapshotPath}`,
		"",
		snapshot,
	]
		.join("\n")
		.trimEnd();
}

export function loadAgentMemoryPromptContext(
	options: { agentDir?: string; now?: Date } = {},
): AgentMemoryPromptContext {
	const paths = ensureMemoryStore(options.agentDir, options.now ?? new Date());
	return {
		morganHomeDir: paths.morganHomeDir,
		memoryDir: paths.memoryDir,
		snapshotPath: paths.snapshotPath,
		promptSection: formatPromptSection(paths),
	};
}
