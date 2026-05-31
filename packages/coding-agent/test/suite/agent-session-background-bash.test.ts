import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager, type BackgroundTaskNotification } from "../../src/core/background-tasks.ts";
import { getShellEnv } from "../../src/utils/shell.ts";
import { createHarness, type Harness } from "./harness.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

function contextHasTaskNotification(context: Context): boolean {
	return contextHasXmlTag(context, "<task-notification>");
}

function contextHasMonitorEvent(context: Context): boolean {
	return contextHasXmlTag(context, "<monitor-event>");
}

function contextHasXmlTag(context: Context, tag: string): boolean {
	return context.messages.some((message) => {
		if (message.role !== "user") {
			return false;
		}
		const content = message.content;
		if (typeof content === "string") {
			return content.includes(tag);
		}
		return content.some((part) => part.type === "text" && part.text.includes(tag));
	});
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
						command: "sleep 0.05; printf 'server ready\\n'; sleep 0.2",
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

	it("emits completed, failed, and timed-out final statuses", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-background-status-"));
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
});
