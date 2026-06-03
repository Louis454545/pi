import type { AgentTool } from "@earendil-works/morgan-agent-core";
import { type Static, Type } from "typebox";
import type { StopBackgroundTaskResult } from "../background-tasks.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const taskStopSchema = Type.Object({
	task_id: Type.String({ description: "Background task id to stop" }),
});

export type TaskStopToolInput = Static<typeof taskStopSchema>;

export interface TaskStopToolDetails {
	taskId: string;
	status: TaskStopResult["status"];
	taskType?: "background" | "subagent";
	name?: string;
	outputFile?: string;
	sessionFile?: string;
	finalStatus?: string;
	exitCode?: number;
}

export interface StopSubagentTaskRecord {
	taskId: string;
	name: string;
	sessionFile: string | undefined;
	finalStatus: "idle" | "stopped" | "failed";
}

export type StopSubagentTaskResult =
	| { type: "subagent"; status: "not_found"; taskId: string }
	| { type: "subagent"; status: "already_finished"; task: StopSubagentTaskRecord }
	| { type: "subagent"; status: "stopped"; task: StopSubagentTaskRecord };

export type TaskStopResult = ({ type?: "background" } & StopBackgroundTaskResult) | StopSubagentTaskResult;

export interface TaskStopToolOptions {
	stopTask?: (taskId: string) => Promise<TaskStopResult>;
}

export function createTaskStopToolDefinition(
	_optionsCwd: string,
	options?: TaskStopToolOptions,
): ToolDefinition<typeof taskStopSchema, TaskStopToolDetails> {
	return {
		name: "task_stop",
		label: "task_stop",
		description:
			"Stop a running background task by task id, or a running subagent by task id or name. Returns a clear status.",
		promptSnippet: "Stop running background tasks or subagents",
		parameters: taskStopSchema,
		async execute(_toolCallId, { task_id }: TaskStopToolInput) {
			if (!options?.stopTask) {
				throw new Error("Background task stopping is not available in this session.");
			}
			const result = await options.stopTask(task_id);
			if (result.status === "not_found") {
				throw new Error(`Task not found: ${result.taskId}`);
			}
			if (result.type === "subagent") {
				if (result.status === "already_finished") {
					return {
						content: [
							{
								type: "text",
								text: `Subagent ${result.task.name} already finished with status ${result.task.finalStatus}.`,
							},
						],
						details: {
							taskId: result.task.taskId,
							taskType: "subagent",
							name: result.task.name,
							status: result.status,
							sessionFile: result.task.sessionFile,
							finalStatus: result.task.finalStatus,
						},
					};
				}
				return {
					content: [{ type: "text", text: `Subagent ${result.task.name} stopped.` }],
					details: {
						taskId: result.task.taskId,
						taskType: "subagent",
						name: result.task.name,
						status: result.status,
						sessionFile: result.task.sessionFile,
						finalStatus: result.task.finalStatus,
					},
				};
			}
			if (result.status === "already_finished") {
				const status = result.task.finalStatus ?? "finished";
				return {
					content: [
						{
							type: "text",
							text: `Background task ${result.task.taskId} already finished with status ${status}.`,
						},
					],
					details: {
						taskId: result.task.taskId,
						taskType: "background",
						status: result.status,
						outputFile: result.task.outputFile,
						finalStatus: result.task.finalStatus,
						exitCode: result.task.exitCode,
					},
				};
			}
			return {
				content: [{ type: "text", text: `Background task ${result.task.taskId} stopped.` }],
				details: {
					taskId: result.task.taskId,
					taskType: "background",
					status: result.status,
					outputFile: result.task.outputFile,
					finalStatus: result.task.finalStatus,
					exitCode: result.task.exitCode,
				},
			};
		},
	};
}

export function createTaskStopTool(cwd: string, options?: TaskStopToolOptions): AgentTool<typeof taskStopSchema> {
	return wrapToolDefinition(createTaskStopToolDefinition(cwd, options));
}
