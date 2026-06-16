import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextScheduleRun, startScheduleTimer, validateTriggerSchedule } from "../src/core/extensions/trigger-cron.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("trigger-cron validateTriggerSchedule", () => {
	const now = new Date("2026-01-01T00:00:00Z");

	it("accepts a valid cron and a valid interval", () => {
		expect(() => validateTriggerSchedule({ cron: "0 9 * * 1-5", timezone: "Europe/Paris" }, now)).not.toThrow();
		expect(() => validateTriggerSchedule({ intervalMs: 1000 }, now)).not.toThrow();
	});

	it("rejects empty/invalid cron, too-small interval, and both-or-neither sources", () => {
		expect(() => validateTriggerSchedule({ cron: "   " }, now)).toThrow();
		expect(() => validateTriggerSchedule({ cron: "not a cron" }, now)).toThrow();
		expect(() => validateTriggerSchedule({ intervalMs: 500 }, now)).toThrow();
		expect(() => validateTriggerSchedule({} as never, now)).toThrow();
		expect(() => validateTriggerSchedule({ cron: "0 9 * * *", intervalMs: 1000 } as never, now)).toThrow();
	});
});

describe("trigger-cron nextScheduleRun", () => {
	it("advances by the interval for interval schedules", () => {
		const from = new Date("2026-01-01T00:00:00Z");
		expect(nextScheduleRun({ intervalMs: 5000 }, from).getTime()).toBe(from.getTime() + 5000);
	});

	it("returns the next cron occurrence strictly after `from`", () => {
		const from = new Date("2026-01-01T08:00:00Z");
		const next = nextScheduleRun({ cron: "0 9 * * *", timezone: "UTC" }, from);
		expect(next.getTime()).toBe(new Date("2026-01-01T09:00:00Z").getTime());
	});
});

describe("trigger-cron startScheduleTimer", () => {
	let nowMs: number;
	const now = () => new Date(nowMs);
	const flushMicrotasks = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}
	};
	const advance = async (ms: number): Promise<void> => {
		nowMs += ms;
		vi.advanceTimersByTime(ms);
		await flushMicrotasks();
	};

	beforeEach(() => {
		nowMs = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-arms long delays instead of firing early when the timeout is capped", async () => {
		const controller = new AbortController();
		const longInterval = 40 * DAY_MS; // larger than MAX_TIMER_DELAY_MS (~24.8 days)
		let fires = 0;
		startScheduleTimer(
			{ intervalMs: longInterval },
			() => {
				fires++;
			},
			{ signal: controller.signal, now },
		);

		// First wakeup after the capped chunk: real due time has not arrived yet.
		await advance(MAX_TIMER_DELAY_MS);
		expect(fires).toBe(0);

		// Remaining time until the real due time elapses.
		await advance(longInterval - MAX_TIMER_DELAY_MS);
		expect(fires).toBe(1);

		controller.abort();
	});

	it("keeps running after a rejected run without throwing", async () => {
		const controller = new AbortController();
		let attempts = 0;
		startScheduleTimer(
			{ intervalMs: 1000 },
			async () => {
				attempts++;
				throw new Error("boom");
			},
			{ signal: controller.signal, now },
		);

		await advance(1000);
		expect(attempts).toBe(1);

		// A transient failure must not stop subsequent ticks.
		await advance(1000);
		expect(attempts).toBe(2);

		controller.abort();
	});

	it("stops firing after abort", async () => {
		const controller = new AbortController();
		let fires = 0;
		startScheduleTimer(
			{ intervalMs: 1000 },
			() => {
				fires++;
			},
			{ signal: controller.signal, now },
		);

		controller.abort();
		await advance(5000);
		expect(fires).toBe(0);
	});
});
