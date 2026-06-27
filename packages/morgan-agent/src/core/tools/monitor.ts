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
			"Run a command in the background and treat complete stdout and stderr lines as live events that can trigger agent turns. Output is also written to a file for extra context, diagnosis, verification, or explicit user requests, but after starting a monitor do not repeatedly read or poll that output file to do the monitor's job. Use deliberately filtered, preferably unbuffered commands for session-local watchers or processes whose meaningful new lines require contextual evaluation while they are still running. Adapt the command to the signal: batch bursts before emitting them, filter duplicates, routine logs, heartbeats, unchanged state, and weak signals, and emit concise contextual groups instead of raw streams. For example, a message-like event source should collect closely related new messages and emit one actionable group rather than one line per incoming message. If a monitor is too noisy, silent, incomplete, or watching the wrong signal, stop or replace it with a better filtered monitor and continue.",
		promptSnippet:
			"Run quiet filtered watchers; batch bursty meaningful events before triggering turns; do not replace them with output-file polling",
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
