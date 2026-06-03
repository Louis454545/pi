import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

interface OverlapState {
	count?: number;
	release?: () => void;
}

function schedulesDir(harness: Harness): string {
	return join(harness.tempDir, CONFIG_DIR_NAME, "schedules");
}

function writeSchedule(harness: Harness, name: string, content: string): string {
	const dir = schedulesDir(harness);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, content);
	return file;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function waitForCondition(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("AgentSession scheduler", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.useRealTimers();
	});

	it("loads interval schedules and persists schedule notifications without triggering a turn by default", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const harness = await createHarness({ enableSchedules: true });
		harnesses.push(harness);

		writeSchedule(
			harness,
			"interval.ts",
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

export default defineSchedule({
  name: "interval-test",
  description: "Interval test",
  trigger: { intervalMs: 1000 },
  async run(ctx) {
    await ctx.notifyAgent({ summary: "interval fired", message: ctx.cwd });
  },
});
`,
		);

		await harness.session.reload({ scope: "schedules" });
		expect(harness.session.getScheduleStatuses()).toMatchObject([
			{
				name: "interval-test",
				description: "Interval test",
				state: "loaded",
				trigger: "every 1000ms",
				nextRunAt: "2026-01-01T00:00:01.000Z",
			},
		]);

		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();

		const notifications = harness.eventsOfType("schedule_notification");
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.notification.summary).toBe("interval fired");
		expect(notifications[0]?.xml).toContain("<schedule-name>interval-test</schedule-name>");
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "schedule_notification",
			),
		).toBe(true);
	});

	it("loads cron schedules with cron-parser timing", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const harness = await createHarness({ enableSchedules: true });
		harnesses.push(harness);

		writeSchedule(
			harness,
			"cron.ts",
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

export default defineSchedule({
  name: "cron-test",
  trigger: { cron: "*/1 * * * * *", timezone: "UTC" },
  async run(ctx) {
    await ctx.notifyAgent({ summary: "cron fired" });
  },
});
`,
		);

		await harness.session.reload({ scope: "schedules" });
		expect(harness.session.getScheduleStatuses()[0]?.nextRunAt).toBe("2026-01-01T00:00:01.000Z");

		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();

		expect(harness.eventsOfType("schedule_notification")[0]?.notification.summary).toBe("cron fired");
	});

	it("starts an idle turn when a schedule notification requests triggerTurn", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const harness = await createHarness({ enableSchedules: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled schedule notification")]);

		writeSchedule(
			harness,
			"trigger-turn.ts",
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

export default defineSchedule({
  name: "trigger-turn-test",
  trigger: { intervalMs: 1000 },
  async run(ctx) {
    await ctx.notifyAgent({
      summary: "trigger turn",
      triggerTurn: true,
      deliverAs: "nextTurn",
    });
  },
});
`,
		);

		await harness.session.reload({ scope: "schedules" });
		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();

		expect(getAssistantTexts(harness)).toEqual(["handled schedule notification"]);
	});

	it("does not load schedules when schedules are disabled", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const harness = await createHarness({ enableSchedules: false });
		harnesses.push(harness);

		writeSchedule(
			harness,
			"disabled.ts",
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

export default defineSchedule({
  name: "disabled-test",
  trigger: { intervalMs: 1000 },
  async run(ctx) {
    await ctx.notifyAgent({ summary: "should not run" });
  },
});
`,
		);

		await harness.session.reload({ scope: "schedules" });
		await vi.advanceTimersByTimeAsync(5000);
		await flushMicrotasks();

		expect(harness.session.getScheduleStatuses()).toEqual([]);
		expect(harness.eventsOfType("schedule_notification")).toHaveLength(0);
	});

	it("reports duplicate names and does not start duplicate schedules", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const harness = await createHarness({ enableSchedules: true });
		harnesses.push(harness);

		writeSchedule(
			harness,
			"one.ts",
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

export default defineSchedule({
  name: "duplicate-test",
  trigger: { intervalMs: 1000 },
  async run(ctx) {
    await ctx.notifyAgent({ summary: "one" });
  },
});
`,
		);
		const nestedDir = join(schedulesDir(harness), "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(
			join(nestedDir, "index.ts"),
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

export default defineSchedule({
  name: "duplicate-test",
  trigger: { intervalMs: 1000 },
  async run(ctx) {
    await ctx.notifyAgent({ summary: "two" });
  },
});
`,
		);

		await harness.session.reload({ scope: "schedules" });
		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();

		const statuses = harness.session.getScheduleStatuses();
		expect(statuses).toHaveLength(2);
		expect(statuses.every((status) => status.state === "error")).toBe(true);
		expect(statuses[0]?.error).toContain('Duplicate schedule name "duplicate-test"');
		expect(harness.eventsOfType("schedule_notification")).toHaveLength(0);
	});

	it("runs direct exec in the session cwd and includes structured notification data", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const harness = await createHarness({ enableSchedules: true });
		harnesses.push(harness);

		const scriptPath = join(harness.tempDir, "cwd.mjs");
		writeFileSync(scriptPath, "console.log(process.cwd());\n");
		writeSchedule(
			harness,
			"exec.ts",
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

export default defineSchedule({
  name: "exec-test",
  trigger: { intervalMs: 1000 },
  async run(ctx) {
    const result = await ctx.exec(process.execPath, [${JSON.stringify(scriptPath)}]);
    await ctx.notifyAgent({
      summary: "exec complete",
      data: { stdout: result.stdout.trim(), code: result.code },
    });
  },
});
`,
		);

		await harness.session.reload({ scope: "schedules" });
		await vi.advanceTimersByTimeAsync(1000);
		vi.useRealTimers();
		await waitForCondition(() => harness.eventsOfType("schedule_notification").length > 0);

		const notification = harness.eventsOfType("schedule_notification")[0]?.notification;
		expect(notification?.summary).toBe("exec complete");
		expect(notification?.data).toEqual({ stdout: harness.tempDir, code: 0 });
	});

	it("prevents overlap and records one pending run", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const overlapState = globalThis as typeof globalThis & { __piScheduleOverlap?: OverlapState };
		overlapState.__piScheduleOverlap = {};
		const harness = await createHarness({ enableSchedules: true });
		harnesses.push(harness);

		writeSchedule(
			harness,
			"overlap.ts",
			`import { defineSchedule } from "@earendil-works/pi-coding-agent/schedules";

const state = globalThis.__piScheduleOverlap;

export default defineSchedule({
  name: "overlap-test",
  trigger: { intervalMs: 1000 },
  async run(ctx) {
    state.count = (state.count ?? 0) + 1;
    if (state.count === 1) {
      await new Promise((resolve) => {
        state.release = resolve;
      });
    }
    await ctx.notifyAgent({ summary: "run " + state.count });
  },
});
`,
		);

		await harness.session.reload({ scope: "schedules" });
		await vi.advanceTimersByTimeAsync(1000);
		await flushMicrotasks();

		expect(overlapState.__piScheduleOverlap.count).toBe(1);
		await vi.advanceTimersByTimeAsync(3000);
		await flushMicrotasks();
		expect(overlapState.__piScheduleOverlap.count).toBe(1);
		expect(harness.session.getScheduleStatuses()[0]).toMatchObject({ running: true, pending: true });

		overlapState.__piScheduleOverlap.release?.();
		await vi.advanceTimersByTimeAsync(0);
		await flushMicrotasks();
		await flushMicrotasks();
		expect(overlapState.__piScheduleOverlap.count).toBe(2);
		expect(harness.session.getScheduleStatuses()[0]).toMatchObject({ running: false, pending: false });
		expect(harness.eventsOfType("schedule_notification").map((event) => event.notification.summary)).toEqual([
			"run 1",
			"run 2",
		]);
	});
});
