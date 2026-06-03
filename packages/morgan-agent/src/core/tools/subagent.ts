import type { AgentTool } from "@earendil-works/morgan-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const subagentSchema = Type.Object({
	action: Type.Optional(
		Type.Unknown({
			description:
				'Optional literal string. Omit this for normal sends. Use only "list" or "status" when needed; never pass an object.',
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Stable target subagent name. Omit from inside a subagent session to send the message to the parent.",
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"Message to send. If the named subagent does not exist yet, this message becomes its initial task.",
		}),
	),
});

export type SubagentToolInput = Static<typeof subagentSchema>;
export type SubagentAction = "send" | "list" | "status";
export type SubagentStatus = "running" | "idle" | "stopped" | "failed";

export interface SubagentInfo {
	name: string;
	taskId: string;
	status: SubagentStatus;
	sessionFile: string | undefined;
	parentSessionFile: string | undefined;
	startedAt: number;
	endedAt: number | undefined;
	lastSummary: string | undefined;
}

export interface SubagentToolDetails {
	action: SubagentAction;
	name?: string;
	taskId?: string;
	status?: SubagentStatus;
	sessionFile?: string;
	parentSessionFile?: string;
	subagents?: SubagentInfo[];
}

export interface SubagentToolActionResult extends SubagentToolDetails {
	message: string;
}

export type SubagentToolActionHandler = (input: SubagentToolInput) => Promise<SubagentToolActionResult>;

export interface SubagentToolOptions {
	handleAction?: SubagentToolActionHandler;
}

export function normalizeSubagentAction(input: SubagentToolInput): SubagentAction {
	if (input.action === undefined) {
		return "send";
	}
	if (input.action === "send" || input.action === "list" || input.action === "status") {
		return input.action;
	}
	if (input.message?.trim()) {
		return "send";
	}
	throw new Error('subagent action must be omitted or one of the literal strings "send", "list", or "status".');
}

function requireString(value: string | undefined, field: string, action: SubagentAction): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`subagent action "${action}" requires ${field}.`);
	}
	return trimmed;
}

function validateInput(input: SubagentToolInput): void {
	const action = normalizeSubagentAction(input);
	switch (action) {
		case "send":
			requireString(input.message, "message", action);
			return;
		case "status":
			if (input.name !== undefined && input.name.trim().length === 0) {
				throw new Error('subagent action "status" received an empty name.');
			}
			return;
		case "list":
			return;
	}
}

export function createSubagentToolDefinition(
	_optionsCwd: string,
	options?: SubagentToolOptions,
): ToolDefinition<typeof subagentSchema, SubagentToolDetails> {
	return {
		name: "subagent",
		label: "subagent",
		description:
			"Send messages to persistent named subagents, creating them when needed; list or inspect them; and let subagents message their parent. For normal use, pass only name and message.",
		promptSnippet: "Delegate work to persistent named subagents with JSONL traces and async notifications",
		promptGuidelines: [
			'For normal delegation, omit action and call subagent with exactly name and message. Example: {"name":"researcher","message":"Inspect package.json and report back."}',
			"To give more information to an existing subagent, omit action and reuse the same name with a new message.",
			'If you are running as a subagent, omit action and send {"message":"..."} with no name to report useful findings or ask the parent for information.',
			'Only use action as a literal string for management calls: {"action":"list"} or {"action":"status","name":"researcher"}. Never use action for reasoning text or objects.',
		],
		parameters: subagentSchema,
		async execute(_toolCallId, input: SubagentToolInput) {
			if (!options?.handleAction) {
				throw new Error("Subagent execution is not available in this session.");
			}
			validateInput(input);
			const result = await options.handleAction(input);
			const action = normalizeSubagentAction(input);
			return {
				content: [{ type: "text", text: result.message }],
				details: {
					action,
					name: result.name,
					taskId: result.taskId,
					status: result.status,
					sessionFile: result.sessionFile,
					parentSessionFile: result.parentSessionFile,
					subagents: result.subagents,
				},
			};
		},
	};
}

export function createSubagentTool(cwd: string, options?: SubagentToolOptions): AgentTool<typeof subagentSchema> {
	return wrapToolDefinition(createSubagentToolDefinition(cwd, options));
}
