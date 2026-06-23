import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriggerEmit } from "@earendil-works/morgan-agent";
import { type Context, fauxAssistantMessage, fauxToolCall, type TextContent } from "@earendil-works/morgan-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager, type BackgroundTaskNotification } from "../../src/core/background-tasks.ts";
import { getShellEnv } from "../../src/utils/shell.ts";
import { createHarness, type Harness } from "./harness.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextContent(value: unknown): value is TextContent {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function contentToText(content: string | readonly unknown[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter(isTextContent)
		.map((part) => part.text)
		.join("\n");
}

function getBackgroundTaskId(context: Context): string {
	for (const message of context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "bash") {
			continue;
		}
		const details = message.details;
		if (!isRecord(details)) {
			continue;
		}
		const backgroundTask = details.backgroundTask;
		if (!isRecord(backgroundTask)) {
			continue;
		}
		const taskId = backgroundTask.taskId;
		if (typeof taskId === "string") {
			return taskId;
		}
	}
	throw new Error("missing background task id");
}

function getBackgroundTaskIds(context: Context): string[] {
	const ids: string[] = [];
	for (const message of context.messages) {
		if (message.role !== "toolResult" || message.toolName !== "bash") {
			continue;
		}
		const details = message.details;
		if (!isRecord(details)) {
			continue;
		}
		const backgroundTask = details.backgroundTask;
		if (!isRecord(backgroundTask)) {
			continue;
		}
		const taskId = backgroundTask.taskId;
		if (typeof taskId === "string") {
			ids.push(taskId);
		}
	}
	return ids;
}

function getBashToolResultTexts(context: Context): string[] {
	const texts: string[] = [];
	for (const message of context.messages) {
		if (message.role === "toolResult" && message.toolName === "bash") {
			texts.push(contentToText(message.content));
		}
	}
	return texts;
}

function contextHasTaskNotification(context: Context): boolean {
	return contextHasXmlTag(context, "<task-notification>");
}

function contextHasMonitorEvent(context: Context): boolean {
	return contextHasXmlTag(context, "<monitor-event>");
}

function contextHasProactiveTriggerEvent(context: Context): boolean {
	return contextHasXmlTag(context, "<proactive-trigger-event>");
}

function getLastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (!message || message.role !== "user") {
			continue;
		}
		return contentToText(message.content);
	}
	return "";
}

function contextHasUserText(context: Context, expectedText: string): boolean {
	return context.messages.some(
		(message) => message.role === "user" && contentToText(message.content) === expectedText,
	);
}

function contextHasXmlTag(context: Context, tag: string): boolean {
	return context.messages.some((message) => {
		if (message.role !== "user") {
			return false;
		}
		return contentToText(message.content).includes(tag);
	});
}

function waitForBashUpdateContaining(harness: Harness, expectedText: string): Promise<void> {
	return new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_update" || event.toolName !== "bash") {
				return;
			}
			const text = contentToText(event.partialResult.content);
			if (text.includes(expectedText)) {
				unsubscribe();
				resolve();
			}
		});
	});
}

function listBackgroundAccumulatorLogs(): Set<string> {
	return new Set(
		readdirSync(tmpdir()).filter((entry) => entry.startsWith("morgan-background-") && entry.endsWith(".log")),
	);
}

function listBashAccumulatorLogs(): Set<string> {
	return new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("morgan-bash-") && entry.endsWith(".log")));
}

describe("AgentSession background bash tasks", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("stops a long-running background bash task and injects the stopped notification", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let stoppedTaskId: string | undefined;
		let notificationReachedModel = false;

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: "sleep 30",
						description: "slow sleep",
						run_in_background: true,
					},
					{ id: "bash-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				stoppedTaskId = getBackgroundTaskId(context);
				return fauxAssistantMessage(
					fauxToolCall("task_stop", { task_id: stoppedTaskId }, { id: "stop-tool-call" }),
					{
						stopReason: "toolUse",
					},
				);
			},
			(context) => {
				notificationReachedModel = contextHasTaskNotification(context);
				return fauxAssistantMessage("saw stopped notification");
			},
		]);

		await harness.session.prompt("start a background command and stop it");

		expect(stoppedTaskId).toBeDefined();
		if (!stoppedTaskId) {
			throw new Error("missing stopped task id");
		}
		const task = harness.session.getBackgroundTask(stoppedTaskId);
		expect(task?.finalStatus).toBe("stopped");
		expect(task?.processState).toBe("exited");
		expect(task?.outputFile && existsSync(task.outputFile)).toBe(true);

		const notifications = harness.eventsOfType("task_notification");
		expect(notifications).toHaveLength(1);
		expect(notifications[0].notification.status).toBe("stopped");
		expect(notifications[0].notification.taskId).toBe(stoppedTaskId);
		expect(notifications[0].notification.toolUseId).toBe("bash-tool-call");
		expect(notifications[0].xml).toContain("<status>stopped</status>");
		expect(notifications[0].xml).toContain("Background command &quot;slow sleep&quot; stopped");
		expect(notificationReachedModel).toBe(true);
	});

	it("keeps foreground bash foreground when no inbound signal arrives", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let bashOutput = "";
		let backgroundTaskIds: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "printf 'foreground done\\n'" }, { id: "foreground-bash-tool-call" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				bashOutput = getBashToolResultTexts(context).join("\n");
				backgroundTaskIds = getBackgroundTaskIds(context);
				return fauxAssistantMessage("saw foreground bash");
			},
		]);

		await harness.session.prompt("run a short foreground bash command");

		expect(bashOutput).toContain("foreground done");
		expect(backgroundTaskIds).toEqual([]);
		expect(harness.eventsOfType("task_notification")).toHaveLength(0);
	});

	it("returns when a foreground shell exits even if a descendant keeps stdio open", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let bashOutput = "";
		let backgroundTaskIds: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{ command: "sleep 3 & printf 'foreground shell done\\n'" },
					{ id: "daemonizing-foreground-bash-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				bashOutput = getBashToolResultTexts(context).join("\n");
				backgroundTaskIds = getBackgroundTaskIds(context);
				return fauxAssistantMessage("saw daemonizing foreground bash");
			},
		]);

		const startedAt = Date.now();
		await harness.session.prompt("run a foreground command that backgrounds a descendant");
		const elapsedMs = Date.now() - startedAt;

		expect(bashOutput).toContain("foreground shell done");
		expect(backgroundTaskIds).toEqual([]);
		expect(harness.eventsOfType("task_notification")).toHaveLength(0);
		expect(elapsedMs).toBeLessThan(1500);
	});

	it("promotes foreground bash when a proactive notification arrives", async () => {
		let emit: TriggerEmit | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "incoming",
						start: (_ctx, triggerEmit) => {
							emit = triggerEmit;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		let promotedTaskId: string | undefined;
		let promotedToolOutput = "";
		let triggerReachedModel = false;
		let finalNotificationReachedModel = false;

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: "printf 'partial output\\n'; sleep 0.8; printf 'late output\\n'",
						description: "promotable bash",
					},
					{ id: "promotable-bash-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				promotedTaskId = getBackgroundTaskId(context);
				promotedToolOutput = getBashToolResultTexts(context).join("\n");
				triggerReachedModel = contextHasProactiveTriggerEvent(context);
				return fauxAssistantMessage("handled incoming trigger");
			},
			(context) => {
				finalNotificationReachedModel = contextHasTaskNotification(context);
				return fauxAssistantMessage("saw promoted bash completion");
			},
		]);

		await harness.session.bindExtensions({});
		const sawBashUpdate = waitForBashUpdateContaining(harness, "partial output");
		const promptPromise = harness.session.prompt("run bash and handle incoming trigger");
		await sawBashUpdate;
		emit?.({ eventId: "incoming-1", summary: "incoming notification" });
		await promptPromise;
		await harness.session.waitForBackgroundTasks();

		expect(promotedTaskId).toBeDefined();
		expect(promotedToolOutput).toContain("partial output");
		expect(promotedToolOutput).toContain("Command is continuing in background.");
		expect(triggerReachedModel).toBe(true);
		expect(finalNotificationReachedModel).toBe(true);
		if (promotedTaskId) {
			expect(harness.session.getBackgroundTask(promotedTaskId)?.finalStatus).toBe("completed");
		}
	});

	it("does not leak local bash temp files when promoting truncated output", async () => {
		let emit: TriggerEmit | undefined;
		const logsBefore = listBashAccumulatorLogs();
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "large",
						start: (_ctx, triggerEmit) => {
							emit = triggerEmit;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		let promotedTaskId: string | undefined;
		let promotedToolOutput = "";

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: "node -e \"process.stdout.write('x'.repeat(60000)); setTimeout(() => {}, 800)\"",
						description: "large promotable bash",
					},
					{ id: "large-promotable-bash-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				promotedTaskId = getBackgroundTaskId(context);
				promotedToolOutput = getBashToolResultTexts(context).join("\n");
				return fauxAssistantMessage("handled large promotion");
			},
			fauxAssistantMessage("saw large promotion completion"),
		]);

		await harness.session.bindExtensions({});
		const sawBashUpdate = waitForBashUpdateContaining(harness, "xxxxxxxxxx");
		const promptPromise = harness.session.prompt("run large bash and handle incoming trigger");
		await sawBashUpdate;
		emit?.({ eventId: "large-1", summary: "large notification" });
		await promptPromise;
		await harness.session.waitForBackgroundTasks();
		const logsAfter = listBashAccumulatorLogs();
		const createdLogs = [...logsAfter].filter((entry) => !logsBefore.has(entry));

		expect(promotedTaskId).toBeDefined();
		expect(promotedToolOutput).toContain("Command is continuing in background.");
		expect(createdLogs).toEqual([]);
	});

	it("promotes foreground bash when user input is queued during tool execution", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let promotedTaskId: string | undefined;
		let queuedUserReachedModel = false;

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: "printf 'before input\\n'; sleep 0.8; printf 'after input\\n'",
						description: "user interrupted bash",
					},
					{ id: "user-promoted-bash-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				promotedTaskId = getBackgroundTaskId(context);
				queuedUserReachedModel = contextHasUserText(context, "new input");
				return fauxAssistantMessage("handled queued input");
			},
			fauxAssistantMessage("saw user promoted bash completion"),
		]);

		const sawBashUpdate = waitForBashUpdateContaining(harness, "before input");
		const promptPromise = harness.session.prompt("run bash and accept user input");
		await sawBashUpdate;
		await harness.session.prompt("new input", { streamingBehavior: "steer" });
		await promptPromise;
		await harness.session.waitForBackgroundTasks();

		expect(promotedTaskId).toBeDefined();
		expect(queuedUserReachedModel).toBe(true);
		if (promotedTaskId) {
			expect(harness.session.getBackgroundTask(promotedTaskId)?.finalStatus).toBe("completed");
		}
	});

	it("promotes every active foreground bash in a parallel tool batch", async () => {
		let emit: TriggerEmit | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "parallel",
						start: (_ctx, triggerEmit) => {
							emit = triggerEmit;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		let promotedTaskIds: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{ command: "printf 'one started\\n'; sleep 0.8; printf 'one done\\n'", description: "one" },
						{ id: "parallel-bash-one" },
					),
					fauxToolCall(
						"bash",
						{ command: "printf 'two started\\n'; sleep 0.8; printf 'two done\\n'", description: "two" },
						{ id: "parallel-bash-two" },
					),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				promotedTaskIds = getBackgroundTaskIds(context);
				return fauxAssistantMessage("handled parallel trigger");
			},
			fauxAssistantMessage("saw parallel completion one"),
			fauxAssistantMessage("saw parallel completion two"),
		]);

		await harness.session.bindExtensions({});
		const sawBothBashUpdates = Promise.all([
			waitForBashUpdateContaining(harness, "one started"),
			waitForBashUpdateContaining(harness, "two started"),
		]);
		const promptPromise = harness.session.prompt("run parallel bash commands");
		await sawBothBashUpdates;
		emit?.({ eventId: "parallel-1", summary: "parallel notification" });
		await promptPromise;
		await harness.session.waitForBackgroundTasks();

		expect(promotedTaskIds).toHaveLength(2);
		for (const taskId of promotedTaskIds) {
			expect(harness.session.getBackgroundTask(taskId)?.finalStatus).toBe("completed");
		}
	});

	it("surfaces monitor output lines while the command is still running", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let eventReachedModel = false;
		let finalNotificationReachedModel = false;

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"monitor",
					{
						command: "sleep 0.05; printf 'server ready\\n'; sleep 0.8",
						description: "dev server",
					},
					{ id: "monitor-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("monitor started"),
			(context) => {
				eventReachedModel = contextHasMonitorEvent(context);
				return fauxAssistantMessage("saw monitor event");
			},
			(context) => {
				finalNotificationReachedModel = contextHasTaskNotification(context);
				return fauxAssistantMessage("saw monitor completion");
			},
		]);

		await harness.session.prompt("start a monitored command");
		await harness.session.waitForBackgroundTasks();

		const monitorEvents = harness.eventsOfType("monitor_event");
		expect(monitorEvents.length).toBeGreaterThan(0);
		expect(monitorEvents[0].notification.toolUseId).toBe("monitor-tool-call");
		expect(monitorEvents[0].notification.events).toContain("server ready");
		expect(monitorEvents[0].xml).toContain("<monitor-event>");
		expect(monitorEvents[0].xml).toContain("<event>server ready</event>");

		const notifications = harness.eventsOfType("task_notification");
		const monitorFinal = notifications.find((event) => event.notification.toolUseId === "monitor-tool-call");
		expect(monitorFinal?.notification.status).toBe("completed");
		expect(monitorFinal?.notification.summary).toContain('Monitor command "dev server" completed');
		expect(eventReachedModel).toBe(true);
		expect(finalNotificationReachedModel).toBe(true);
	});

	it("coalesces bursty monitor output before starting idle turns", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const monitorTurnTexts: string[] = [];
		let finalNotificationReachedModel = false;

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"monitor",
					{
						command:
							"printf 'message one\\n'; sleep 0.15; printf 'message two\\n'; sleep 0.15; printf 'message three\\n'; sleep 0.7",
						description: "message stream",
					},
					{ id: "monitor-burst-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("monitor started"),
			(context) => {
				const lastUserText = getLastUserText(context);
				if (lastUserText.includes("<monitor-event>")) {
					monitorTurnTexts.push(lastUserText);
				}
				return fauxAssistantMessage("saw monitor burst");
			},
			(context) => {
				const lastUserText = getLastUserText(context);
				if (lastUserText.includes("<monitor-event>")) {
					monitorTurnTexts.push(lastUserText);
				}
				finalNotificationReachedModel = lastUserText.includes("<task-notification>");
				return fauxAssistantMessage("saw monitor completion");
			},
		]);

		await harness.session.prompt("start a bursty monitored command");
		await harness.session.waitForBackgroundTasks();

		const monitorEvents = harness.eventsOfType("monitor_event");
		expect(monitorEvents).toHaveLength(3);
		expect(monitorTurnTexts).toHaveLength(1);
		expect(monitorTurnTexts[0]).toContain("<event>message one</event>");
		expect(monitorTurnTexts[0]).toContain("<event>message two</event>");
		expect(monitorTurnTexts[0]).toContain("<event>message three</event>");
		expect(finalNotificationReachedModel).toBe(true);
	});

	it("queues monitor events that arrive while a monitor turn is running", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const monitorTurnTexts: string[] = [];
		let finalNotificationReachedModel = false;

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"monitor",
					{
						command: "printf 'message one\\n'; sleep 0.8; printf 'message two\\n'; sleep 0.8",
						description: "message stream",
					},
					{ id: "monitor-queued-tool-call" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("monitor started"),
			(context) => {
				monitorTurnTexts.push(getLastUserText(context));
				return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1" }, { id: "busy-tool-call" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const lastUserText = getLastUserText(context);
				if (lastUserText.includes("<monitor-event>")) {
					monitorTurnTexts.push(lastUserText);
				}
				return fauxAssistantMessage("continued after busy work");
			},
			(context) => {
				const lastUserText = getLastUserText(context);
				if (lastUserText.includes("<monitor-event>")) {
					monitorTurnTexts.push(lastUserText);
				}
				if (lastUserText.includes("<task-notification>")) {
					finalNotificationReachedModel = true;
				}
				return fauxAssistantMessage("saw queued monitor event");
			},
			(context) => {
				if (getLastUserText(context).includes("<task-notification>")) {
					finalNotificationReachedModel = true;
				}
				return fauxAssistantMessage("saw monitor completion");
			},
		]);

		await harness.session.prompt("start a monitored command and stay busy");
		await harness.session.waitForBackgroundTasks();

		expect(monitorTurnTexts[0]).toContain("<event>message one</event>");
		expect(monitorTurnTexts.some((text) => text.includes("<event>message two</event>"))).toBe(true);
		expect(finalNotificationReachedModel).toBe(true);
	});

	it("emits completed, failed, and timed-out final statuses", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "morgan-background-status-"));
		tempDirs.push(tempDir);
		const notifications: BackgroundTaskNotification[] = [];
		const manager = new BackgroundTaskManager((notification) => {
			notifications.push(notification);
		});

		const completed = await manager.startBash({
			command: "printf done",
			description: "complete",
			cwd: tempDir,
			env: getShellEnv(),
			toolUseId: "completed-tool",
		});
		const failed = await manager.startBash({
			command: "exit 7",
			description: "fail",
			cwd: tempDir,
			env: getShellEnv(),
			toolUseId: "failed-tool",
		});
		const timedOut = await manager.startBash({
			command: "sleep 30",
			description: "timeout",
			cwd: tempDir,
			env: getShellEnv(),
			timeout: 0.01,
			toolUseId: "timeout-tool",
		});
		const monitorTimedOut = await manager.startMonitor({
			command: "sleep 30",
			description: "monitor timeout",
			cwd: tempDir,
			env: getShellEnv(),
			timeout: 0.01,
			toolUseId: "monitor-timeout-tool",
		});

		await manager.waitForAll();

		expect(manager.getTask(completed.taskId)?.finalStatus).toBe("completed");
		expect(manager.getTask(failed.taskId)?.finalStatus).toBe("failed");
		expect(manager.getTask(failed.taskId)?.exitCode).toBe(7);
		expect(manager.getTask(timedOut.taskId)?.finalStatus).toBe("timed_out");
		expect(manager.getTask(monitorTimedOut.taskId)?.finalStatus).toBe("timed_out");
		expect(notifications.map((notification) => notification.status).sort()).toEqual([
			"completed",
			"failed",
			"timed_out",
			"timed_out",
		]);
		expect(notifications.find((notification) => notification.taskId === failed.taskId)?.exitCode).toBe(7);
		expect(existsSync(completed.outputFile)).toBe(true);
		expect(existsSync(failed.outputFile)).toBe(true);
		expect(existsSync(timedOut.outputFile)).toBe(true);
		expect(existsSync(monitorTimedOut.outputFile)).toBe(true);
		manager.dispose();
	});

	it("cleans up hidden promotable bash tasks that finish without promotion", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "morgan-promotable-cleanup-"));
		tempDirs.push(tempDir);
		const notifications: BackgroundTaskNotification[] = [];
		const manager = new BackgroundTaskManager((notification) => {
			notifications.push(notification);
		});

		const task = await manager.startPromotableBash({
			command: "printf hidden",
			description: "hidden foreground",
			cwd: tempDir,
			env: getShellEnv(),
			toolUseId: "hidden-tool",
		});

		const completion = await task.completion;

		expect(completion.task.finalStatus).toBe("completed");
		expect(completion.output.content).toContain("hidden");
		expect(manager.getTask(task.taskId)).toBeUndefined();
		expect(existsSync(task.outputFile)).toBe(false);
		expect(notifications).toEqual([]);
		manager.dispose();
	});

	it("does not promote a promotable bash task after it starts stopping", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "morgan-promotable-stopping-"));
		tempDirs.push(tempDir);
		const notifications: BackgroundTaskNotification[] = [];
		const manager = new BackgroundTaskManager((notification) => {
			notifications.push(notification);
		});

		const task = await manager.startPromotableBash({
			command: "sleep 30",
			description: "stopping foreground",
			cwd: tempDir,
			env: getShellEnv(),
			toolUseId: "stopping-tool",
		});

		task.stop();
		const promotion = task.promote();
		const completion = await task.completion;

		expect(promotion).toBeUndefined();
		expect(completion.task.finalStatus).toBe("stopped");
		expect(completion.task.processState).toBe("exited");
		expect(notifications).toEqual([]);
		manager.dispose();
	});

	it("does not create duplicate accumulator temp files for large managed output", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "morgan-large-background-"));
		tempDirs.push(tempDir);
		const logsBefore = listBackgroundAccumulatorLogs();
		const manager = new BackgroundTaskManager(() => {});

		const task = await manager.startBash({
			command: "node -e \"process.stdout.write('x'.repeat(60000))\"",
			description: "large output",
			cwd: tempDir,
			env: getShellEnv(),
			toolUseId: "large-output-tool",
		});

		await manager.waitForAll();
		const logsAfter = listBackgroundAccumulatorLogs();
		const createdLogs = [...logsAfter].filter((entry) => !logsBefore.has(entry));

		expect(manager.getTask(task.taskId)?.finalStatus).toBe("completed");
		expect(existsSync(task.outputFile)).toBe(true);
		expect(createdLogs).toEqual([]);
		manager.dispose();
	});
});
