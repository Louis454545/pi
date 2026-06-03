/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import type { AgentMemoryPromptContext } from "./agent-memory.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Pre-loaded global identity and memory context. */
	memoryContext?: AgentMemoryPromptContext;
}

function formatMemoryManagementInstructions(memoryContext: AgentMemoryPromptContext | undefined): string {
	if (!memoryContext) {
		return "";
	}

	return `

# Persistent Identity and Memory

Pi has global, instance-level memory under ${memoryContext.piHomeDir}. These files are not workspace-specific.

- SOUL.md and IDENTITY.md describe who the agent is.
- USER.md describes durable context about the primary user.
- MEMORY.md stores compact durable long-term memory.
- ${memoryContext.dailyMemoryPath} is today's episodic daily memory.
- ${memoryContext.piHomeDir}/sessions stores raw session history.
- ${memoryContext.piHomeDir}/memory-index stores local search/index data for memories and sessions.

Manage memory proactively when it will reduce future repetition from the user. Notice explicit "remember this" requests, recurring preferences, corrections, stable personal context, durable decisions, and long-term facts about people, channels, routines, projects, or goals. Search existing memory or prior sessions before asking the user to repeat durable context.

Update or remove stale memories when corrected, and consolidate redundant memories when possible. Store memory entries as compact declarative facts, not imperative commands. Do not save temporary task progress, raw logs, large code blocks, transient debugging details, one-off plans, or facts likely to become stale quickly.

Use daily memory for detailed notes, fresh context, observations, open loops, and memory candidates. Promote only durable facts from daily memory into USER.md or MEMORY.md. Before compaction or context loss, preserve genuinely useful long-term context and avoid saving temporary task state.`;
}

function appendMemorySections(prompt: string, memoryContext: AgentMemoryPromptContext | undefined): string {
	if (!memoryContext) {
		return prompt;
	}

	let nextPrompt = `${prompt}${formatMemoryManagementInstructions(memoryContext)}\n\n${memoryContext.identitySection}`;
	if (memoryContext.retrievedSection) {
		nextPrompt += `\n\n${memoryContext.retrievedSection}`;
	}
	return nextPrompt;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		prompt = appendMemorySections(prompt, options.memoryContext);

		// Append working context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<working_context>\n\n";
			prompt += "Working-context instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<working_context_instructions path="${filePath}">\n${content}\n</working_context_instructions>\n\n`;
			}
			prompt += "</working_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working context: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");
	addGuideline(
		"If the user provides a token or credential for this workspace, treat it as authorized for use and store it in the workspace auth storage when appropriate instead of asking for revocation or re-entry.",
	);

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert computer agent operating inside pi, an agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	prompt = appendMemorySections(prompt, options.memoryContext);

	// Append working context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<working_context>\n\n";
		prompt += "Working-context instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<working_context_instructions path="${filePath}">\n${content}\n</working_context_instructions>\n\n`;
		}
		prompt += "</working_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working context: ${promptCwd}`;

	return prompt;
}
