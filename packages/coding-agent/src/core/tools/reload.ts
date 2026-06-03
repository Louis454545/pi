import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const reloadScopeSchema = Type.Union([Type.Literal("all"), Type.Literal("runtime"), Type.Literal("schedules")]);
const reloadSchema = Type.Object({
	scope: Type.Optional(reloadScopeSchema),
});

export type ReloadToolInput = Static<typeof reloadSchema>;
export type ReloadScope = Static<typeof reloadScopeSchema>;

export interface ReloadToolDetails {
	scheduled: boolean;
	scope: ReloadScope;
}

export interface ReloadToolOptions {
	/** Schedule the active AgentSession to reload after the current tool turn. */
	scheduleReload?: (scope?: ReloadScope) => void;
}

export function createReloadToolDefinition(
	_optionsCwd: string,
	options?: ReloadToolOptions,
): ToolDefinition<typeof reloadSchema, ReloadToolDetails> {
	return {
		name: "reload",
		label: "reload",
		description:
			"Schedule a pi reload after modifying files that affect the running agent, including schedules, extensions, skills, prompts, themes, settings, or keybindings.",
		promptSnippet: "Reload pi runtime resources after agent-affecting edits",
		promptGuidelines: [
			"After you create, edit, delete, install, or update files that affect the running pi agent, call reload before you say the work is complete.",
			"Agent-affecting files include pi schedules, extensions, skills, prompt templates, themes, keybindings, settings, AGENTS.md/project instructions, and other files loaded into the system prompt, command/autocomplete runtime, or scheduler.",
			"If a user asks for a new slash command, extension, skill, theme, keybinding, or prompt behavior, reload after writing the files so the command or behavior is available immediately.",
			'After you create, edit, or delete files under .pi/schedules, call reload with scope "schedules" so the scheduler reloads without rebuilding the full runtime.',
			"Do not use reload after ordinary product source edits, tests, docs, or generated files that the current pi runtime does not load.",
		],
		parameters: reloadSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			const scope = input.scope ?? "all";
			if (!options?.scheduleReload) {
				return {
					content: [{ type: "text", text: "Reload is not available in this context." }],
					details: { scheduled: false, scope },
				};
			}

			options.scheduleReload(scope);
			return {
				content: [
					{
						type: "text",
						text:
							scope === "schedules"
								? "Schedule reload scheduled. Pi will reload schedules before the next model turn."
								: "Reload scheduled. Pi will reload runtime resources before the next model turn.",
					},
				],
				details: { scheduled: true, scope },
			};
		},
	};
}

export function createReloadTool(
	cwd: string,
	options?: ReloadToolOptions,
): AgentTool<typeof reloadSchema, ReloadToolDetails> {
	return wrapToolDefinition(createReloadToolDefinition(cwd, options));
}
