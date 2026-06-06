import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	const memoryContext = {
		morganHomeDir: "/tmp/morgan",
		dailyMemoryPath: "/tmp/morgan/memories/daily/2026-06-01.md",
		identitySection: [
			"# Agent Identity Context",
			"",
			"## SOUL.md",
			"soul",
			"",
			"## IDENTITY.md",
			"identity",
			"",
			"## USER.md",
			"user",
			"",
			"## MEMORY.md",
			"memory",
		].join("\n"),
		retrievedSection: "# Retrieved Memory Context\n\nretrieved daily note",
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
			expect(prompt).toContain(
				"Store stable user facts, preferences, relationships, and long-term context in memory",
			);
			expect(prompt).toContain("Store procedures, workflows, checklists, command sequences");
			expect(prompt).toContain("Do not put procedural instructions in memory when they should become a skill");
			expect(prompt).toContain("When authoring a skill, make it operational, not vague");
			expect(prompt).toContain("specific trigger-focused description");
			expect(prompt).toContain("Create Morgan-owned resources in Morgan-owned locations:");
			expect(prompt).toContain("Global personal skills: ~/.morgan/agent/skills/<skill-name>/SKILL.md");
			expect(prompt).toContain("Project skills: <current working context>/.morgan/skills/<skill-name>/SKILL.md");
			expect(prompt).toContain("Global personal extensions: ~/.morgan/agent/extensions/<extension-name>.ts");
			expect(prompt).toContain(
				"Project extensions: <current working context>/.morgan/extensions/<extension-name>.ts",
			);
			expect(prompt).toContain("Global proactive trigger extensions:");
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
		test("injects memory sections in stable order before working context", () => {
			const prompt = buildSystemPrompt({
				cwd: process.cwd(),
				contextFiles: [{ path: "/repo/AGENTS.md", content: "Working-context instructions" }],
				skills: [],
				memoryContext,
			});

			const coreIndex = prompt.indexOf("You are Morgan: a proactive universal computer agent");
			const policyIndex = prompt.indexOf("# Persistent Identity and Memory");
			const identityIndex = prompt.indexOf("# Agent Identity Context");
			const soulIndex = prompt.indexOf("## SOUL.md");
			const agentIdentityIndex = prompt.indexOf("## IDENTITY.md");
			const userIndex = prompt.indexOf("## USER.md");
			const memoryIndex = prompt.indexOf("## MEMORY.md");
			const retrievedIndex = prompt.indexOf("# Retrieved Memory Context");
			const workingContextIndex = prompt.indexOf("<working_context>");

			expect(coreIndex).toBeGreaterThanOrEqual(0);
			expect(policyIndex).toBeGreaterThan(coreIndex);
			expect(identityIndex).toBeGreaterThan(policyIndex);
			expect(soulIndex).toBeGreaterThan(identityIndex);
			expect(agentIdentityIndex).toBeGreaterThan(soulIndex);
			expect(userIndex).toBeGreaterThan(agentIdentityIndex);
			expect(memoryIndex).toBeGreaterThan(userIndex);
			expect(retrievedIndex).toBeGreaterThan(memoryIndex);
			expect(workingContextIndex).toBeGreaterThan(retrievedIndex);
			expect(prompt).toContain("Current working context:");
			expect(prompt).not.toContain("<project_context>");
		});
	});
});
