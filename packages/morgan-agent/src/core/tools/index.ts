export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createMonitorTool,
	createMonitorToolDefinition,
	type MonitorToolDetails,
	type MonitorToolInput,
	type MonitorToolOptions,
} from "./monitor.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createReloadTool,
	createReloadToolDefinition,
	type ReloadToolDetails,
	type ReloadToolInput,
	type ReloadToolOptions,
} from "./reload.ts";
export {
	createSubagentTool,
	createSubagentToolDefinition,
	type SubagentInfo,
	type SubagentStatus,
	type SubagentToolActionHandler,
	type SubagentToolActionResult,
	type SubagentToolDetails,
	type SubagentToolInput,
	type SubagentToolOptions,
} from "./subagent.ts";
export {
	createTaskStopTool,
	createTaskStopToolDefinition,
	type TaskStopToolDetails,
	type TaskStopToolInput,
	type TaskStopToolOptions,
} from "./task-stop.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/morgan-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createMonitorTool, createMonitorToolDefinition, type MonitorToolOptions } from "./monitor.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createReloadTool, createReloadToolDefinition, type ReloadToolOptions } from "./reload.ts";
import { createSubagentTool, createSubagentToolDefinition, type SubagentToolOptions } from "./subagent.ts";
import { createTaskStopTool, createTaskStopToolDefinition, type TaskStopToolOptions } from "./task-stop.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "reload" | "task_stop" | "monitor" | "subagent";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"reload",
	"task_stop",
	"monitor",
	"subagent",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	reload?: ReloadToolOptions;
	taskStop?: TaskStopToolOptions;
	monitor?: MonitorToolOptions;
	subagent?: SubagentToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "reload":
			return createReloadToolDefinition(cwd, options?.reload);
		case "task_stop":
			return createTaskStopToolDefinition(cwd, options?.taskStop);
		case "monitor":
			return createMonitorToolDefinition(cwd, options?.monitor);
		case "subagent":
			return createSubagentToolDefinition(cwd, options?.subagent);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "reload":
			return createReloadTool(cwd, options?.reload);
		case "task_stop":
			return createTaskStopTool(cwd, options?.taskStop);
		case "monitor":
			return createMonitorTool(cwd, options?.monitor);
		case "subagent":
			return createSubagentTool(cwd, options?.subagent);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
		createReloadToolDefinition(cwd, options?.reload),
		createTaskStopToolDefinition(cwd, options?.taskStop),
		createMonitorToolDefinition(cwd, options?.monitor),
		createSubagentToolDefinition(cwd, options?.subagent),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [createReadToolDefinition(cwd, options?.read)];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		reload: createReloadToolDefinition(cwd, options?.reload),
		task_stop: createTaskStopToolDefinition(cwd, options?.taskStop),
		monitor: createMonitorToolDefinition(cwd, options?.monitor),
		subagent: createSubagentToolDefinition(cwd, options?.subagent),
	};
}

export function createMorganTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
		createReloadTool(cwd, options?.reload),
		createTaskStopTool(cwd, options?.taskStop),
		createMonitorTool(cwd, options?.monitor),
		createSubagentTool(cwd, options?.subagent),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read)];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		reload: createReloadTool(cwd, options?.reload),
		task_stop: createTaskStopTool(cwd, options?.taskStop),
		monitor: createMonitorTool(cwd, options?.monitor),
		subagent: createSubagentTool(cwd, options?.subagent),
	};
}
