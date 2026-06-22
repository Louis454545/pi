import type { AgentTool } from "@earendil-works/morgan-agent-core";
import { type Static, Type } from "typebox";
import { getShellEnv } from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BashSpawnContext, BashSpawnHook } from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const monitorSchema = Type.Object({
	command: Type.String({ description: "Command to run and monitor" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	description: Type.Optional(Type.String({ description: "Short description for monitor events and notifications" })),
});

export type MonitorToolInput = Static<typeof monitorSchema>;

export interface MonitorToolDetails {
	taskId: string;
	outputFile: string;
}

export interface MonitorTaskStartInput extends BashSpawnContext {
	toolUseId: string;
	description: string;
	timeout?: number;
	displayCommand: string;
}

export interface MonitorTaskStartResult {
	taskId: string;
	outputFile: string;
	message: string;
}

export type MonitorTaskStarter = (input: MonitorTaskStartInput) => Promise<MonitorTaskStartResult>;

export interface MonitorToolOptions {
	/** Command prefix prepended to every monitored command */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Starts a session-managed monitor task. */
	startMonitorTask?: MonitorTaskStarter;
}

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export function createMonitorToolDefinition(
	cwd: string,
	options?: MonitorToolOptions,
): ToolDefinition<typeof monitorSchema, MonitorToolDetails> {
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const startMonitorTask = options?.startMonitorTask;
	return {
		name: "monitor",
		label: "monitor",
		description:
			"Run a command in the background and treat complete stdout and stderr lines as live events that can trigger agent turns. Output is also written to a file. Use deliberately filtered, unbuffered commands for long-running watchers or processes whose new lines require contextual evaluation while they are still running; avoid routine logs, heartbeats, and unchanged state.",
		promptSnippet: "Run quiet background watchers whose meaningful output lines trigger agent turns",
		parameters: monitorSchema,
		async execute(toolCallId, { command, timeout, description }: MonitorToolInput) {
			if (!startMonitorTask) {
				throw new Error("Monitor execution is not available in this session.");
			}
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const task = await startMonitorTask({
				...spawnContext,
				toolUseId: toolCallId,
				description: description?.trim() || command,
				timeout,
				displayCommand: command,
			});
			return {
				content: [
					{
						type: "text",
						text: `${task.message}\n\nTask id: ${task.taskId}\nOutput file: ${task.outputFile}`,
					},
				],
				details: {
					taskId: task.taskId,
					outputFile: task.outputFile,
				},
			};
		},
	};
}

export function createMonitorTool(cwd: string, options?: MonitorToolOptions): AgentTool<typeof monitorSchema> {
	return wrapToolDefinition(createMonitorToolDefinition(cwd, options));
}
