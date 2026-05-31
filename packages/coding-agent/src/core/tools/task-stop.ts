import type { AgentTool } from "@earendil-works/pi-agent-core";
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
	status: StopBackgroundTaskResult["status"];
	outputFile?: string;
	finalStatus?: string;
	exitCode?: number;
}

export interface TaskStopToolOptions {
	stopTask?: (taskId: string) => Promise<StopBackgroundTaskResult>;
}

export function createTaskStopToolDefinition(
	_optionsCwd: string,
	options?: TaskStopToolOptions,
): ToolDefinition<typeof taskStopSchema, TaskStopToolDetails> {
	return {
		name: "task_stop",
		label: "task_stop",
		description:
			"Stop a running background task by task id. Stops the whole process tree and returns a clear status.",
		promptSnippet: "Stop running background tasks by task id",
		parameters: taskStopSchema,
		async execute(_toolCallId, { task_id }: TaskStopToolInput) {
			if (!options?.stopTask) {
				throw new Error("Background task stopping is not available in this session.");
			}
			const result = await options.stopTask(task_id);
			if (result.status === "not_found") {
				throw new Error(`Background task not found: ${result.taskId}`);
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
