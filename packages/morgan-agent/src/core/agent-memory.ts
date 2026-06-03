import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getMorganHomeDir } from "../config.ts";

const IDENTITY_FILE_NAMES = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const;
const MAX_IDENTITY_FILE_CHARS = 12000;
const MAX_RETRIEVED_MEMORY_CHARS = 12000;
const MAX_RETRIEVED_FILE_CHARS = 4000;
const MAX_RETRIEVED_FILES = 3;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

type IdentityFileName = (typeof IDENTITY_FILE_NAMES)[number];

export interface AgentMemoryPromptContext {
	morganHomeDir: string;
	dailyMemoryPath: string;
	identitySection: string;
	retrievedSection?: string;
}

interface MemoryFileRead {
	name: IdentityFileName;
	path: string;
	content: string;
	originalChars: number;
	truncated: boolean;
}

interface DailyMemoryCandidate {
	path: string;
	content: string;
	score: number;
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
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

function truncateForPrompt(content: string, maxChars: number): { content: string; truncated: boolean } {
	if (content.length <= maxChars) {
		return { content, truncated: false };
	}

	const clipped = content.slice(0, maxChars);
	const lastNewline = clipped.lastIndexOf("\n");
	const safeEnd = lastNewline > Math.floor(maxChars * 0.75) ? lastNewline : maxChars;
	const truncatedChars = content.length - safeEnd;
	return {
		content: `${content.slice(0, safeEnd).trimEnd()}\n\n[Injected copy truncated by ${truncatedChars} characters. Read the full file from its path when needed.]`,
		truncated: true,
	};
}

function defaultIdentityFileContent(name: IdentityFileName): string {
	switch (name) {
		case "SOUL.md":
			return "# SOUL.md\n\n";
		case "IDENTITY.md":
			return "# IDENTITY.md\n\n";
		case "USER.md":
			return "# USER.md\n\n";
		case "MEMORY.md":
			return "# MEMORY.md\n\n";
	}
}

function ensureMemoryHome(morganHomeDir: string, now: Date): string {
	ensurePrivateDir(morganHomeDir);
	ensurePrivateDir(join(morganHomeDir, "memories"));
	ensurePrivateDir(join(morganHomeDir, "memories", "daily"));
	ensurePrivateDir(join(morganHomeDir, "sessions"));
	ensurePrivateDir(join(morganHomeDir, "memory-index"));

	for (const name of IDENTITY_FILE_NAMES) {
		ensureFile(join(morganHomeDir, name), defaultIdentityFileContent(name));
	}

	const day = formatLocalDate(now);
	const dailyMemoryPath = join(morganHomeDir, "memories", "daily", `${day}.md`);
	ensureFile(
		dailyMemoryPath,
		[`# ${day}`, "", "## Notes", "", "## Observations", "", "## Open Loops", "", "## Memory Candidates", ""].join(
			"\n",
		),
	);
	return dailyMemoryPath;
}

function readIdentityFiles(morganHomeDir: string): MemoryFileRead[] {
	return IDENTITY_FILE_NAMES.map((name) => {
		const path = join(morganHomeDir, name);
		const raw = readFileSync(path, "utf-8");
		const truncated = truncateForPrompt(raw, MAX_IDENTITY_FILE_CHARS);
		return {
			name,
			path,
			content: truncated.content,
			originalChars: raw.length,
			truncated: truncated.truncated,
		};
	});
}

function formatIdentitySection(files: MemoryFileRead[], morganHomeDir: string, dailyMemoryPath: string): string {
	const lines = [
		"# Agent Identity Context",
		"",
		`Morgan global home: ${morganHomeDir}`,
		`Current daily memory: ${dailyMemoryPath}`,
		"The full files are available through normal file access at the paths shown below.",
		"",
	];

	for (const file of files) {
		lines.push(`## ${file.name}`);
		lines.push(`Path: ${file.path}`);
		lines.push(
			`Status: ${
				file.truncated
					? `truncated injected copy from ${file.originalChars} characters`
					: `loaded ${file.originalChars} characters`
			}`,
		);
		lines.push("");
		lines.push(file.content.trimEnd());
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

function tokenizeQuery(query: string | undefined): Set<string> {
	if (!query) {
		return new Set();
	}
	const stopWords = new Set([
		"about",
		"after",
		"again",
		"also",
		"and",
		"are",
		"can",
		"for",
		"from",
		"how",
		"into",
		"not",
		"now",
		"please",
		"that",
		"the",
		"this",
		"with",
		"you",
	]);
	const tokens = query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [];
	return new Set(tokens.filter((token) => !stopWords.has(token)));
}

function scoreContent(content: string, tokens: Set<string>): number {
	if (tokens.size === 0) {
		return 0;
	}
	const lowerContent = content.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		let index = lowerContent.indexOf(token);
		while (index !== -1) {
			score++;
			index = lowerContent.indexOf(token, index + token.length);
		}
	}
	return score;
}

function findDailyMemoryCandidates(morganHomeDir: string, query: string | undefined): DailyMemoryCandidate[] {
	const tokens = tokenizeQuery(query);
	if (tokens.size === 0) {
		return [];
	}

	const dailyDir = join(morganHomeDir, "memories", "daily");
	let fileNames: string[];
	try {
		fileNames = readdirSync(dailyDir)
			.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
			.sort()
			.reverse();
	} catch {
		return [];
	}

	const candidates: DailyMemoryCandidate[] = [];
	for (const fileName of fileNames.slice(0, 60)) {
		const path = join(dailyDir, fileName);
		let content: string;
		try {
			content = readFileSync(path, "utf-8");
		} catch {
			continue;
		}
		const score = scoreContent(content, tokens);
		if (score > 0) {
			candidates.push({ path, content, score });
		}
	}

	return candidates.sort((a, b) => b.score - a.score || basename(b.path).localeCompare(basename(a.path)));
}

function formatRetrievedSection(candidates: DailyMemoryCandidate[]): string | undefined {
	if (candidates.length === 0) {
		return undefined;
	}

	const lines = [
		"# Retrieved Memory Context",
		"",
		"Relevant excerpts selected from daily episodic memory. These are partial excerpts, not full files.",
		"",
	];
	let remaining = MAX_RETRIEVED_MEMORY_CHARS;

	for (const candidate of candidates.slice(0, MAX_RETRIEVED_FILES)) {
		const header = `## ${candidate.path}\nScore: ${candidate.score}\n\n`;
		const maxContentChars = Math.max(0, Math.min(MAX_RETRIEVED_FILE_CHARS, remaining - header.length));
		if (maxContentChars <= 0) {
			break;
		}
		const truncated = truncateForPrompt(candidate.content, maxContentChars);
		const section = `${header}${truncated.content.trimEnd()}\n`;
		lines.push(section);
		remaining -= section.length;
	}

	return lines.join("\n").trimEnd();
}

export function loadAgentMemoryPromptContext(
	options: { agentDir?: string; query?: string; now?: Date } = {},
): AgentMemoryPromptContext {
	const now = options.now ?? new Date();
	const morganHomeDir = getMorganHomeDir(options.agentDir);
	const dailyMemoryPath = ensureMemoryHome(morganHomeDir, now);
	const identityFiles = readIdentityFiles(morganHomeDir);
	const candidates = findDailyMemoryCandidates(morganHomeDir, options.query);

	return {
		morganHomeDir,
		dailyMemoryPath,
		identitySection: formatIdentitySection(identityFiles, morganHomeDir, dailyMemoryPath),
		retrievedSection: formatRetrievedSection(candidates),
	};
}
