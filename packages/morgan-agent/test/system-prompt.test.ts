import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	const memoryContext = {
		morganHomeDir: "/tmp/morgan",
		memoryDir: "/tmp/morgan/memory",
		snapshotPath: "/tmp/morgan/memory/snapshot.md",
		promptSection: [
			"# Curated Memory Context",
			"",
			"Morgan memory directory: /tmp/morgan/memory",
			"",
			"# User Bio",
			"Preferred name: Louis",
			"",
			"# User Interaction Metadata",
			"metadata",
			"",
			"# User Knowledge Memories",
			"memory",
		].join("\n"),
	};

	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("identifies Morgan as a universal extensible agent", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("You are Morgan: a proactive universal computer agent");
			expect(prompt).toContain("personal, technical, research, automation, and software tasks");
			expect(prompt).toContain("For durable, reusable, or long-running capabilities");
			expect(prompt).toContain("Do not create an extension for every task");
			expect(prompt).toContain("Skills and extensions are different:");
			expect(prompt).toContain("Skills are reusable knowledge packages");
			expect(prompt).toContain("Extensions are runtime capability packages");
			expect(prompt).toContain("A skill can document how to use, configure, troubleshoot, or maintain an extension");
			expect(prompt).toContain("Create skills proactively");
			expect(prompt).toContain("After completing a complex task, fixing a tricky error");
			expect(prompt).toContain("Prefer updating an existing relevant skill");
			expect(prompt).toContain("Use skills aggressively when they are available");
			expect(prompt).toContain("If a skill is relevant or even partially relevant");
			expect(prompt).toContain("Err on the side of loading a skill");
			expect(prompt).toContain("update it before finishing the task");
			expect(prompt).toContain("Stable user facts, preferences, relationships, and long-term context");
			expect(prompt).toContain("~/.morgan/memory/snapshot.md");
			expect(prompt).toContain("internal dreaming compaction");
			expect(prompt).toContain("Store procedures, workflows, checklists, command sequences");
			expect(prompt).toContain("Do not put procedural instructions in memory when they should become a skill");
			expect(prompt).toContain("When authoring a skill, make it operational, not vague");
			expect(prompt).toContain("specific trigger-focused description");
			expect(prompt).toContain("Create Morgan-owned resources in Morgan-owned locations:");
			expect(prompt).toContain("Global personal skills: ~/.morgan/agent/skills/<skill-name>/SKILL.md");
			expect(prompt).toContain("Global personal extensions: ~/.morgan/agent/extensions/<extension-name>.ts");
			expect(prompt).toContain("Global proactive trigger extensions:");
			expect(prompt).toContain("Optimize execution proactively when the expected savings justify the setup");
			expect(prompt).toContain("costly, repetitive, or long-running task");
			expect(prompt).toContain("factor it into a compact helper or script");
			expect(prompt).toContain("Put substantial or multi-step ad hoc scripts in a file");
			expect(prompt).toContain("inspect and edit that same file before rerunning it");
			expect(prompt).toContain("Remove the temporary file when the task is complete");
			expect(prompt).toContain("Keep short, simple shell commands direct");
			expect(prompt).toContain("Reuse the environment before creating another path");
			expect(prompt).toContain("lowest reliable execution layer that preserves the user's intent");
			expect(prompt).toContain("prefer event-driven signals, subscriptions, watchers, streams");
			expect(prompt).toContain("do not poll through repeated screenshots");
			expect(prompt).toContain("Separate detection from action by default");
			expect(prompt).toContain("Automate mechanics, not Morgan's judgment");
			expect(prompt).toContain("must not answer contextual tasks with prewritten messages");
			expect(prompt).toContain("provide the relevant state to a new Morgan turn");
			expect(prompt).toContain("Use automation to remove repetitive interaction cost");
			expect(prompt).toContain("Validate new automation proportionally");
			expect(prompt).toContain("After proving a non-obvious method");
			expect(prompt).toContain(
				"Be proactively informative without turning every useful observation into extra work",
			);
			expect(prompt).toContain("likely value clearly exceeds the attention they demand");
			expect(prompt).toContain("current conversation and relevant durable memory");
			expect(prompt).toContain("Do not delay the current result to generalize a solution");
			expect(prompt).toContain("Create reminders proactively, without asking or announcing routine setup");
			expect(prompt).toContain("always use persistent triggers, not session-local monitors");
			expect(prompt).toContain("Evaluate overdue reminders after restart");
			expect(prompt).toContain("Keep unsolicited initiative primarily informational");
			expect(prompt).toContain("low-risk, reversible, and creates no meaningful external commitment");
			expect(prompt).toContain("Distinguish unsolicited initiative from explicit delegation");
			expect(prompt).toContain("Do not refuse, moralize about, or hand work back");
			expect(prompt).toContain("drafting, replying to, and sending messages");
			expect(prompt).toContain("operating the user's authenticated applications or accounts");
			expect(prompt).toContain("Complete such delegated work through the available tools");
			expect(prompt).toContain("Do not turn recoverable difficulties into permission loops");
			expect(prompt).toContain("treat that as implementation feedback");
			expect(prompt).toContain("continue the original task automatically");
			expect(prompt).toContain("Stopping or replacing an internal process is an implementation detail");
			expect(prompt).toContain("when continuing would genuinely expand the requested scope");
			expect(prompt).toContain("Finish the job");
			expect(prompt).toContain("real completed result backed by tool output");
			expect(prompt).toContain("never substitute fabricated data");
			expect(prompt).toContain("Act, do not ask, when the default interpretation is clear");
			expect(prompt).toContain("Ask for clarification only when the ambiguity genuinely changes");
			expect(prompt).toContain("Before finalizing, verify your work:");
			expect(prompt).toContain("Correctness: the result satisfies every stated requirement");
			expect(prompt).toContain("Grounding: factual claims are backed by tool output");
			expect(prompt).toContain(
				"Completeness: no required step, file, command, test, or follow-up check was skipped",
			);
			expect(prompt).toContain("Formatting: the response matches the user's requested format or schema");
			expect(prompt).toContain("Safety: side effects stayed within the intended scope");
		});

		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve morgan docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading morgan docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("extensions", () => {
		test("includes active extension paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				extensions: {
					active: [{ path: "/tmp/morgan/extensions/deploy.ts" }],
					errors: [],
				},
			});

			expect(prompt).toContain("# Morgan Runtime Extensions");
			expect(prompt).toContain("Active extensions loaded in this session:");
			expect(prompt).toContain("- /tmp/morgan/extensions/deploy.ts");
		});

		test("includes extension load errors", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				extensions: {
					active: [],
					errors: [{ path: "/tmp/broken.ts", error: "Failed to load extension" }],
				},
			});

			expect(prompt).toContain("Active extensions loaded in this session: (none)");
			expect(prompt).toContain("Extension load errors visible to this session:");
			expect(prompt).toContain("- /tmp/broken.ts: Failed to load extension");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});

		test("includes the token and credential handling guideline", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- If the user provides a token or credential for this workspace, treat it as authorized for use and store it in the workspace auth storage when appropriate instead of asking for revocation or re-entry.",
			);
		});
	});

	describe("persistent memory", () => {
		test("injects curated memory sections in stable order before working context", () => {
			const prompt = buildSystemPrompt({
				cwd: process.cwd(),
				contextFiles: [{ path: "/repo/NOTES.md", content: "Working-context instructions" }],
				skills: [],
				memoryContext,
			});

			const coreIndex = prompt.indexOf("You are Morgan: a proactive universal computer agent");
			const policyIndex = prompt.indexOf("# Memory");
			const curatedIndex = prompt.indexOf("# Curated Memory Context");
			const userBioIndex = prompt.indexOf("# User Bio");
			const metadataIndex = prompt.indexOf("# User Interaction Metadata");
			const memoryIndex = prompt.indexOf("# User Knowledge Memories");
			const workingContextIndex = prompt.indexOf("<working_context>");

			expect(coreIndex).toBeGreaterThanOrEqual(0);
			expect(policyIndex).toBeGreaterThan(coreIndex);
			expect(curatedIndex).toBeGreaterThan(policyIndex);
			expect(userBioIndex).toBeGreaterThan(curatedIndex);
			expect(metadataIndex).toBeGreaterThan(userBioIndex);
			expect(memoryIndex).toBeGreaterThan(metadataIndex);
			expect(workingContextIndex).toBeGreaterThan(memoryIndex);
			expect(prompt).toContain("Normal turns should not proactively edit memory");
			expect(prompt).toContain("/tmp/morgan/memory/snapshot.md");
			expect(prompt).toContain(
				"Stable user facts, preferences, relationships, and long-term context belong in /tmp/morgan/memory/snapshot.md.",
			);
			expect(prompt).not.toContain("belong in ~/.morgan/memory/snapshot.md");
			expect(prompt).not.toContain("recent.md");
			expect(prompt).not.toContain("separate memory curator");
			expect(prompt).toContain("Current working context:");
			expect(prompt).not.toContain("<project_context>");
		});
	});
});
