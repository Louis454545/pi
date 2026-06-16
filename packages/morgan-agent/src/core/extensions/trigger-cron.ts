import { CronExpressionParser } from "cron-parser";
import type { TriggerSchedule } from "./types.ts";

const MIN_INTERVAL_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Throws if the schedule is malformed (bad cron expression or out-of-range interval). */
export function validateTriggerSchedule(schedule: TriggerSchedule, now: Date = new Date()): void {
	const hasCron = typeof schedule.cron === "string";
	const hasInterval = typeof schedule.intervalMs === "number";
	if (hasCron === hasInterval) {
		throw new Error("Trigger schedule must specify exactly one of cron or intervalMs");
	}

	if (hasCron) {
		const cron = schedule.cron?.trim();
		if (!cron) {
			throw new Error("Trigger schedule cron must be a non-empty string");
		}
		if (schedule.timezone !== undefined && typeof schedule.timezone !== "string") {
			throw new Error("Trigger schedule timezone must be a string");
		}
		CronExpressionParser.parse(cron, { tz: schedule.timezone?.trim() || undefined, currentDate: now });
		return;
	}

	const intervalMs = schedule.intervalMs;
	if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) {
		throw new Error("Trigger schedule intervalMs must be a finite number");
	}
	if (intervalMs < MIN_INTERVAL_MS) {
		throw new Error(`Trigger schedule intervalMs must be at least ${MIN_INTERVAL_MS}`);
	}
}

/** Compute the next fire time for a schedule, relative to `from`. */
export function nextScheduleRun(schedule: TriggerSchedule, from: Date): Date {
	if (typeof schedule.cron === "string") {
		return CronExpressionParser.parse(schedule.cron, {
			tz: schedule.timezone,
			currentDate: from,
		})
			.next()
			.toDate();
	}
	return new Date(from.getTime() + (schedule.intervalMs ?? MIN_INTERVAL_MS));
}

/**
 * Arm a re-arming timer for a declarative schedule. Calls `onFire` on each tick (skipping a tick if a
 * previous run is still in progress) and returns a cleanup that stops the timer. Honors `signal`.
 */
export function startScheduleTimer(
	schedule: TriggerSchedule,
	onFire: () => void | Promise<void>,
	options: { signal: AbortSignal; now?: () => Date },
): () => void {
	const now = options.now ?? (() => new Date());
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dueAt: Date | undefined;
	let running = false;
	let stopped = false;

	// setTimeout cannot represent delays beyond ~24.8 days, so long waits are split into
	// capped chunks. Each wakeup re-checks the real due time and only fires once it has passed.
	const scheduleTimer = (): void => {
		if (stopped || options.signal.aborted || !dueAt) {
			return;
		}
		const delayMs = Math.min(Math.max(0, dueAt.getTime() - now().getTime()), MAX_TIMER_DELAY_MS);
		timer = setTimeout(onTimer, delayMs);
	};

	const armNext = (from: Date): void => {
		dueAt = nextScheduleRun(schedule, from);
		scheduleTimer();
	};

	const onTimer = (): void => {
		timer = undefined;
		if (stopped || options.signal.aborted || !dueAt) {
			return;
		}
		if (now().getTime() < dueAt.getTime()) {
			scheduleTimer();
			return;
		}
		armNext(now());
		if (running) {
			return;
		}
		running = true;
		void Promise.resolve()
			.then(onFire)
			.catch(() => {})
			.finally(() => {
				running = false;
			});
	};

	const cleanup = (): void => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	options.signal.addEventListener("abort", cleanup, { once: true });
	armNext(now());
	return cleanup;
}
