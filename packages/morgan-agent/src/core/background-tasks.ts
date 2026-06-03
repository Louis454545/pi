import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn } from "child_process";
import { stripAnsi } from "../utils/ansi.ts";
import {
	getShellConfig,
	killProcessTree,
	sanitizeBinaryOutput,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../utils/shell.ts";

export type BackgroundTaskFinalStatus = "completed" | "failed" | "stopped" | "timed_out";
export type BackgroundTaskProcessState = "running" | "stopping" | "exited";

export interface BackgroundTaskRecord {
	taskId: string;
	command: string;
	description: string;
	outputFile: string;
	processState: BackgroundTaskProcessState;
	exitCode: number | undefined;
	finalStatus: BackgroundTaskFinalStatus | undefined;
	toolUseId: string | undefined;
	startedAt: number;
	endedAt: number | undefined;
}

export interface BackgroundTaskStartInput {
	toolUseId?: string;
	command: string;
	displayCommand?: string;
	description: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeout?: number;
	shellPath?: string;
}

export interface BackgroundTaskStartResult {
	taskId: string;
	outputFile: string;
	message: string;
}

export interface BackgroundTaskNotification {
	taskId: string;
	toolUseId: string | undefined;
	outputFile: string;
	status: BackgroundTaskFinalStatus;
	summary: string;
	exitCode: number | undefined;
}

export interface MonitorEventNotification {
	taskId: string;
	toolUseId: string | undefined;
	outputFile: string;
	events: string[];
	summary: string;
}

export type BackgroundTaskNotificationHandler = (notification: BackgroundTaskNotification) => void;
export type MonitorEventNotificationHandler = (notification: MonitorEventNotification) => void;

type ManagedTask = BackgroundTaskRecord & {
	child: ChildProcess;
	completion: Promise<BackgroundTaskRecord>;
	resolveCompletion: (record: BackgroundTaskRecord) => void;
	timeoutHandle: NodeJS.Timeout | undefined;
	notify: boolean;
	monitor: boolean;
	decoder: InstanceType<typeof TextDecoder>;
	lineBuffer: string;
	pendingMonitorEvents: string[];
	monitorFlushHandle: NodeJS.Timeout | undefined;
};

export type StopBackgroundTaskResult =
	| { status: "not_found"; taskId: string }
	| { status: "already_finished"; task: BackgroundTaskRecord }
	| { status: "stopped"; task: BackgroundTaskRecord };

function createTaskId(): string {
	return `task_${randomBytes(6).toString("hex")}`;
}

function createOutputFilePath(taskId: string): string {
	return join(tmpdir(), `morgan-background-${taskId}.output`);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function formatTaskNotificationXml(notification: BackgroundTaskNotification): string {
	const lines = [
		"<task-notification>",
		`<task-id>${escapeXml(notification.taskId)}</task-id>`,
		`<tool-use-id>${escapeXml(notification.toolUseId ?? "")}</tool-use-id>`,
		`<output-file>${escapeXml(notification.outputFile)}</output-file>`,
		`<status>${notification.status}</status>`,
		`<summary>${escapeXml(notification.summary)}</summary>`,
		"</task-notification>",
	];
	return lines.join("\n");
}

export function formatMonitorEventXml(notification: MonitorEventNotification): string {
	const lines = [
		"<monitor-event>",
		`<task-id>${escapeXml(notification.taskId)}</task-id>`,
		`<tool-use-id>${escapeXml(notification.toolUseId ?? "")}</tool-use-id>`,
		`<output-file>${escapeXml(notification.outputFile)}</output-file>`,
		"<events>",
		...notification.events.map((event) => `<event>${escapeXml(event)}</event>`),
		"</events>",
		`<summary>${escapeXml(notification.summary)}</summary>`,
		"</monitor-event>",
	];
	return lines.join("\n");
}

function summaryForTask(task: BackgroundTaskRecord & { monitor?: boolean }): string {
	const description = task.description;
	const prefix = task.monitor ? "Monitor command" : "Background command";
	switch (task.finalStatus) {
		case "completed":
			return `${prefix} "${description}" completed (exit code 0)`;
		case "failed":
			return task.exitCode === undefined
				? `${prefix} "${description}" failed`
				: `${prefix} "${description}" failed (exit code ${task.exitCode})`;
		case "stopped":
			return `${prefix} "${description}" stopped`;
		case "timed_out":
			return `${prefix} "${description}" timed out`;
		default:
			return `${prefix} "${description}" finished`;
	}
}

export class BackgroundTaskManager {
	private readonly tasks = new Map<string, ManagedTask>();
	private readonly onNotification: BackgroundTaskNotificationHandler;
	private readonly onMonitorEvent: MonitorEventNotificationHandler;
	private disposed = false;

	constructor(onNotification: BackgroundTaskNotificationHandler, onMonitorEvent?: MonitorEventNotificationHandler) {
		this.onNotification = onNotification;
		this.onMonitorEvent = onMonitorEvent ?? (() => {});
	}

	async startBash(input: BackgroundTaskStartInput): Promise<BackgroundTaskStartResult> {
		return await this.startCommand(input, { monitor: false });
	}

	async startMonitor(input: BackgroundTaskStartInput): Promise<BackgroundTaskStartResult> {
		return await this.startCommand(input, { monitor: true });
	}

	private async startCommand(
		input: BackgroundTaskStartInput,
		options: { monitor: boolean },
	): Promise<BackgroundTaskStartResult> {
		if (this.disposed) {
			throw new Error("Cannot start background task after session disposal");
		}

		await fsAccess(input.cwd, constants.F_OK).catch(() => {
			throw new Error(`Working directory does not exist: ${input.cwd}\nCannot execute bash commands.`);
		});

		const taskId = createTaskId();
		const outputFile = createOutputFilePath(taskId);
		closeSync(openSync(outputFile, "w"));

		const { shell, args } = getShellConfig(input.shellPath);
		const child = spawn(shell, [...args, input.command], {
			cwd: input.cwd,
			detached: process.platform !== "win32",
			env: input.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid) {
			trackDetachedChildPid(child.pid);
		}

		let resolveCompletion: (record: BackgroundTaskRecord) => void = () => {};
		const completion = new Promise<BackgroundTaskRecord>((resolve) => {
			resolveCompletion = resolve;
		});
		const outputStream = openSync(outputFile, "a");
		const task: ManagedTask = {
			taskId,
			command: input.displayCommand ?? input.command,
			description: input.description,
			outputFile,
			processState: "running",
			exitCode: undefined,
			finalStatus: undefined,
			toolUseId: input.toolUseId,
			startedAt: Date.now(),
			endedAt: undefined,
			child,
			completion,
			resolveCompletion,
			timeoutHandle: undefined,
			notify: true,
			monitor: options.monitor,
			decoder: new TextDecoder(),
			lineBuffer: "",
			pendingMonitorEvents: [],
			monitorFlushHandle: undefined,
		};
		this.tasks.set(taskId, task);

		child.stdout?.on("data", (chunk: Buffer) => {
			this.writeOutput(outputStream, chunk);
			if (options.monitor) {
				this.appendMonitorChunk(task, chunk);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.writeOutput(outputStream, chunk);
			if (options.monitor) {
				this.appendMonitorChunk(task, chunk);
			}
		});

		if (input.timeout !== undefined && input.timeout > 0) {
			task.timeoutHandle = setTimeout(() => {
				this.stopManagedTask(task, "timed_out");
			}, input.timeout * 1000);
		}

		child.once("error", () => {
			this.finalizeTask(task, undefined, "failed", outputStream);
		});
		child.once("close", (code) => {
			const inferredStatus =
				task.finalStatus === "stopped" || task.finalStatus === "timed_out"
					? task.finalStatus
					: code === 0
						? "completed"
						: "failed";
			this.finalizeTask(task, code ?? undefined, inferredStatus, outputStream);
		});

		return {
			taskId,
			outputFile,
			message: options.monitor
				? `Monitor command "${input.description}" started. Output lines will be surfaced as events, and the user and agent will be notified when the monitor finishes.`
				: `Background command "${input.description}" started. The user and agent will be notified when the task finishes.`,
		};
	}

	getTask(taskId: string): BackgroundTaskRecord | undefined {
		return this.tasks.get(taskId);
	}

	getRunningTasks(): BackgroundTaskRecord[] {
		return this.getRunningManagedTasks();
	}

	hasRunningTasks(): boolean {
		return this.getRunningManagedTasks().length > 0;
	}

	async stopTask(taskId: string): Promise<StopBackgroundTaskResult> {
		const task = this.tasks.get(taskId);
		if (!task) {
			return { status: "not_found", taskId };
		}
		if (task.processState === "exited") {
			return { status: "already_finished", task };
		}
		if (task.finalStatus !== undefined) {
			const finalized = await task.completion;
			return { status: "already_finished", task: finalized };
		}
		this.stopManagedTask(task, "stopped");
		const finalized = await task.completion;
		return { status: "stopped", task: finalized };
	}

	async waitForAll(): Promise<void> {
		await Promise.all(this.getRunningManagedTasks().map((task) => task.completion));
	}

	dispose(): void {
		this.disposed = true;
		for (const task of this.getRunningManagedTasks()) {
			task.notify = false;
			this.stopManagedTask(task, "stopped");
		}
	}

	private getRunningManagedTasks(): ManagedTask[] {
		return Array.from(this.tasks.values()).filter((task) => task.processState !== "exited");
	}

	private appendMonitorChunk(task: ManagedTask, chunk: Buffer): void {
		const text = sanitizeBinaryOutput(stripAnsi(task.decoder.decode(chunk, { stream: true }))).replace(/\r/g, "");
		if (!text) {
			return;
		}
		task.lineBuffer += text;
		let newlineIndex = task.lineBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = task.lineBuffer.slice(0, newlineIndex);
			task.lineBuffer = task.lineBuffer.slice(newlineIndex + 1);
			this.queueMonitorEvent(task, line);
			newlineIndex = task.lineBuffer.indexOf("\n");
		}
	}

	private finishMonitorEvents(task: ManagedTask): void {
		if (!task.monitor) {
			return;
		}
		const remainder = sanitizeBinaryOutput(stripAnsi(task.decoder.decode())).replace(/\r/g, "");
		if (remainder) {
			task.lineBuffer += remainder;
		}
		if (task.lineBuffer) {
			this.queueMonitorEvent(task, task.lineBuffer);
			task.lineBuffer = "";
		}
		this.flushMonitorEvents(task);
	}

	private queueMonitorEvent(task: ManagedTask, line: string): void {
		if (!task.monitor || !task.notify) {
			return;
		}
		task.pendingMonitorEvents.push(line);
		task.monitorFlushHandle ??= setTimeout(() => {
			task.monitorFlushHandle = undefined;
			this.flushMonitorEvents(task);
		}, 100);
	}

	private flushMonitorEvents(task: ManagedTask): void {
		if (!task.monitor || task.pendingMonitorEvents.length === 0 || !task.notify) {
			return;
		}
		if (task.monitorFlushHandle) {
			clearTimeout(task.monitorFlushHandle);
			task.monitorFlushHandle = undefined;
		}
		const events = task.pendingMonitorEvents;
		task.pendingMonitorEvents = [];
		const count = events.length;
		this.onMonitorEvent({
			taskId: task.taskId,
			toolUseId: task.toolUseId,
			outputFile: task.outputFile,
			events,
			summary: `Monitor command "${task.description}" emitted ${count} event${count === 1 ? "" : "s"}`,
		});
	}

	private writeOutput(fd: number, chunk: Buffer): void {
		try {
			writeSync(fd, chunk);
		} catch {
			// Ignore output persistence errors; the task lifecycle still completes.
		}
	}

	private stopManagedTask(task: ManagedTask, status: "stopped" | "timed_out"): void {
		if (task.finalStatus !== undefined) {
			return;
		}
		task.finalStatus = status;
		task.processState = "stopping";
		if (task.child.pid) {
			killProcessTree(task.child.pid);
		}
	}

	private finalizeTask(
		task: ManagedTask,
		exitCode: number | undefined,
		status: BackgroundTaskFinalStatus,
		outputFd: number,
	): void {
		if (task.processState === "exited") {
			return;
		}
		task.processState = "exited";
		task.exitCode = exitCode;
		task.finalStatus = task.finalStatus ?? status;
		task.endedAt = Date.now();
		this.finishMonitorEvents(task);
		if (task.timeoutHandle) {
			clearTimeout(task.timeoutHandle);
			task.timeoutHandle = undefined;
		}
		if (task.child.pid) {
			untrackDetachedChildPid(task.child.pid);
		}
		try {
			closeSync(outputFd);
		} catch {
			// Ignore close errors.
		}
		task.resolveCompletion(task);
		if (task.notify) {
			this.onNotification({
				taskId: task.taskId,
				toolUseId: task.toolUseId,
				outputFile: task.outputFile,
				status: task.finalStatus,
				summary: summaryForTask(task),
				exitCode: task.exitCode,
			});
		}
	}
}
