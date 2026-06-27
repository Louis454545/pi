import type { AgentTool } from "@earendil-works/morgan-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const reloadSchema = Type.Object({});

export type ReloadToolInput = Static<typeof reloadSchema>;

export interface ReloadToolDetails {
	scheduled: boolean;
}

export interface ReloadToolOptions {
	/** Schedule the active AgentSession to reload after the current tool turn. */
	scheduleReload?: () => void;
}

export function createReloadToolDefinition(
	_optionsCwd: string,
	options?: ReloadToolOptions,
): ToolDefinition<typeof reloadSchema, ReloadToolDetails> {
	return {
		name: "reload",
		label: "reload",
		description:
			"Schedule a morgan reload after modifying files that affect the running agent, including extensions, skills, prompts, themes, settings, or keybindings.",
		promptSnippet: "Reload morgan runtime resources after agent-affecting edits",
		promptGuidelines: [
			"After you create, edit, delete, install, or update files that affect the running morgan agent, call reload before you say the work is complete.",
			"Agent-affecting files include global Morgan extensions, skills, prompt templates, themes, keybindings, settings, and other files loaded into the command or autocomplete runtime.",
			"If a user asks for a new slash command, extension, skill, theme, keybinding, or prompt behavior, reload after writing the files so the command or behavior is available immediately.",
			"Do not use reload after ordinary product source edits, tests, docs, or generated files that the current morgan runtime does not load.",
		],
		parameters: reloadSchema,
		executionMode: "sequential",
		async execute(_toolCallId, _input) {
			if (!options?.scheduleReload) {
				return {
					content: [{ type: "text", text: "Reload is not available in this context." }],
					details: { scheduled: false },
				};
			}

			options.scheduleReload();
			return {
				content: [
					{
						type: "text",
						text: "Reload scheduled. Morgan will reload runtime resources before the next model turn.",
					},
				],
				details: { scheduled: true },
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
