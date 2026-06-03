import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { CronExpressionParser } from "cron-parser";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { execCommand } from "../exec.ts";
import type {
	ScheduleDefinition,
	ScheduleDeliveryMode,
	ScheduleExecOptions,
	ScheduleExecResult,
	ScheduleNotifyAgentInput,
	ScheduleTrigger,
} from "./api.ts";
import { loadScheduleModule } from "./loader.ts";

const MIN_INTERVAL_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_OUTPUT_CHARS = 65_536;
const VALID_SCHEDULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ScheduleNotification {
	scheduleName: string;
	runId: string;
	timestamp: string;
	summary: string;
	message?: string;
	data?: unknown;
}

export interface ScheduleNotificationDeliveryOptions {
	triggerTurn: boolean;
	deliverAs?: ScheduleDeliveryMode;
}

export interface ScheduleStatus {
	name: string;
	description?: string;
	sourceFile: string;
	trigger: string;
	state: "loaded" | "error";
	enabled: boolean;
	nextRunAt?: string;
	lastRunAt?: string;
	lastStatus?: "success" | "error";
	running: boolean;
	pending: boolean;
	error?: string;
	lastError?: string;
}

interface SchedulerManagerOptions {
	cwd: string;
	enabled: boolean;
	onNotification: (
		notification: ScheduleNotification,
		options: ScheduleNotificationDeliveryOptions,
	) => Promise<void> | void;
	now?: () => Date;
}

interface ValidSchedule {
	definition: ScheduleDefinition;
	sourceFile: string;
	triggerDescription: string;
}

interface ActiveSchedule {
	definition: ScheduleDefinition;
	sourceFile: string;
	triggerDescription: string;
	nextRunAt?: Date;
	lastRunAt?: Date;
	lastStatus?: "success" | "error";
	lastError?: string;
	running: boolean;
	pending: boolean;
	timer?: ReturnType<typeof setTimeout>;
	timerDueAt?: Date;
	runAbortController?: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isCronTrigger(trigger: ScheduleTrigger): trigger is { cron: string; timezone?: string } {
	return "cron" in trigger;
}

function formatTrigger(trigger: ScheduleTrigger): string {
	if (isCronTrigger(trigger)) {
		return trigger.timezone ? `${trigger.cron} (${trigger.timezone})` : trigger.cron;
	}
	return `every ${trigger.intervalMs}ms`;
}

function truncateOutput(value: string): { value: string; truncated: boolean } {
	if (value.length <= MAX_EXEC_OUTPUT_CHARS) {
		return { value, truncated: false };
	}
	return {
		value: `${value.slice(0, MAX_EXEC_OUTPUT_CHARS)}\n[output truncated at ${MAX_EXEC_OUTPUT_CHARS} characters]`,
		truncated: true,
	};
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function formatScheduleNotificationXml(notification: ScheduleNotification): string {
	const lines = [
		"<schedule-notification>",
		`<schedule-name>${escapeXml(notification.scheduleName)}</schedule-name>`,
		`<run-id>${escapeXml(notification.runId)}</run-id>`,
		`<timestamp>${escapeXml(notification.timestamp)}</timestamp>`,
		`<summary>${escapeXml(notification.summary)}</summary>`,
	];
	if (notification.message) {
		lines.push(`<message>${escapeXml(notification.message)}</message>`);
	}
	if (notification.data !== undefined) {
		lines.push(`<data-json>${escapeXml(JSON.stringify(notification.data))}</data-json>`);
	}
	lines.push("</schedule-notification>");
	return lines.join("\n");
}

export class SchedulerManager {
	private readonly cwd: string;
	private readonly enabled: boolean;
	private readonly onNotification: SchedulerManagerOptions["onNotification"];
	private readonly now: () => Date;
	private schedules = new Map<string, ActiveSchedule>();
	private statusErrors: ScheduleStatus[] = [];
	private generation = 0;
	private disposed = false;
	private ready: Promise<void> = Promise.resolve();

	constructor(options: SchedulerManagerOptions) {
		this.cwd = options.cwd;
		this.enabled = options.enabled;
		this.onNotification = options.onNotification;
		this.now = options.now ?? (() => new Date());
	}

	getReady(): Promise<void> {
		return this.ready;
	}

	reload(): Promise<void> {
		this.ready = this.reloadNow();
		return this.ready;
	}

	dispose(): void {
		this.disposed = true;
		this.generation++;
		this.clearActiveSchedules();
		this.statusErrors = [];
	}

	getStatuses(): ScheduleStatus[] {
		const loaded = Array.from(this.schedules.values()).map((schedule) => this.toStatus(schedule));
		return [...this.statusErrors, ...loaded].sort((a, b) => a.name.localeCompare(b.name));
	}

	private async reloadNow(): Promise<void> {
		this.generation++;
		this.clearActiveSchedules();
		this.statusErrors = [];

		if (this.disposed || !this.enabled) {
			return;
		}

		const generation = this.generation;
		const files = this.discoverScheduleFiles();
		const candidates: ValidSchedule[] = [];

		for (const file of files) {
			try {
				const definition = await loadScheduleModule(file);
				candidates.push(this.validateScheduleDefinition(definition, file));
			} catch (error) {
				this.statusErrors.push({
					name: path.basename(file),
					sourceFile: file,
					trigger: "",
					state: "error",
					enabled: false,
					running: false,
					pending: false,
					error: errorMessage(error),
				});
			}
		}

		const byName = new Map<string, ValidSchedule[]>();
		for (const candidate of candidates) {
			const list = byName.get(candidate.definition.name) ?? [];
			list.push(candidate);
			byName.set(candidate.definition.name, list);
		}

		for (const [name, list] of byName.entries()) {
			if (list.length > 1) {
				const sources = list.map((entry) => entry.sourceFile).sort();
				for (const duplicate of list) {
					this.statusErrors.push({
						name,
						description: duplicate.definition.description,
						sourceFile: duplicate.sourceFile,
						trigger: duplicate.triggerDescription,
						state: "error",
						enabled: false,
						running: false,
						pending: false,
						error: `Duplicate schedule name "${name}" in ${sources.join(", ")}`,
					});
				}
				continue;
			}

			const candidate = list[0];
			if (!candidate) {
				continue;
			}
			const schedule: ActiveSchedule = {
				definition: candidate.definition,
				sourceFile: candidate.sourceFile,
				triggerDescription: candidate.triggerDescription,
				running: false,
				pending: false,
			};
			this.schedules.set(name, schedule);
			this.scheduleNext(schedule, this.calculateNextRunAt(schedule, this.now()), generation);
		}
	}

	private clearActiveSchedules(): void {
		for (const schedule of this.schedules.values()) {
			if (schedule.timer) {
				clearTimeout(schedule.timer);
			}
			schedule.runAbortController?.abort();
		}
		this.schedules.clear();
	}

	private discoverScheduleFiles(): string[] {
		const schedulesDir = path.join(this.cwd, CONFIG_DIR_NAME, "schedules");
		if (!existsSync(schedulesDir)) {
			return [];
		}

		const files: string[] = [];
		for (const entry of readdirSync(schedulesDir, { withFileTypes: true })) {
			const entryPath = path.join(schedulesDir, entry.name);
			if (
				(entry.isFile() || entry.isSymbolicLink()) &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".d.ts")
			) {
				files.push(entryPath);
				continue;
			}
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const indexPath = path.join(entryPath, "index.ts");
				if (existsSync(indexPath)) {
					files.push(indexPath);
				}
			}
		}
		return files.sort((a, b) => a.localeCompare(b));
	}

	private validateScheduleDefinition(definition: unknown, sourceFile: string): ValidSchedule {
		if (!isRecord(definition)) {
			throw new Error("Schedule module must export a schedule object as default export");
		}
		if (typeof definition.name !== "string" || !VALID_SCHEDULE_NAME.test(definition.name)) {
			throw new Error("Schedule name must be a stable identifier using letters, numbers, '.', '_' or '-'");
		}
		if (definition.description !== undefined && typeof definition.description !== "string") {
			throw new Error("Schedule description must be a string");
		}
		if (!isRecord(definition.trigger)) {
			throw new Error("Schedule trigger must be an object");
		}
		if (typeof definition.run !== "function") {
			throw new Error("Schedule run must be a function");
		}

		const trigger = this.validateTrigger(definition.trigger);
		return {
			definition: {
				name: definition.name,
				description: definition.description,
				trigger,
				run: definition.run as ScheduleDefinition["run"],
			},
			sourceFile,
			triggerDescription: formatTrigger(trigger),
		};
	}

	private validateTrigger(trigger: Record<string, unknown>): ScheduleTrigger {
		const hasCron = "cron" in trigger;
		const hasInterval = "intervalMs" in trigger;
		if (hasCron === hasInterval) {
			throw new Error("Schedule trigger must specify exactly one of cron or intervalMs");
		}

		if (hasCron) {
			if (typeof trigger.cron !== "string" || trigger.cron.trim().length === 0) {
				throw new Error("Schedule cron trigger must be a non-empty string");
			}
			if (trigger.timezone !== undefined && typeof trigger.timezone !== "string") {
				throw new Error("Schedule cron timezone must be a string");
			}
			const cron = trigger.cron.trim();
			const timezone = trigger.timezone?.trim();
			CronExpressionParser.parse(cron, {
				tz: timezone || undefined,
				currentDate: this.now(),
			});
			return timezone ? { cron, timezone } : { cron };
		}

		if (typeof trigger.intervalMs !== "number" || !Number.isFinite(trigger.intervalMs)) {
			throw new Error("Schedule intervalMs trigger must be a finite number");
		}
		if (trigger.intervalMs < MIN_INTERVAL_MS) {
			throw new Error(`Schedule intervalMs must be at least ${MIN_INTERVAL_MS}`);
		}
		return { intervalMs: Math.floor(trigger.intervalMs) };
	}

	private calculateNextRunAt(schedule: ActiveSchedule, currentDate: Date): Date {
		const trigger = schedule.definition.trigger;
		if (isCronTrigger(trigger)) {
			return CronExpressionParser.parse(trigger.cron, {
				tz: trigger.timezone,
				currentDate,
			})
				.next()
				.toDate();
		}
		return new Date(currentDate.getTime() + trigger.intervalMs);
	}

	private scheduleNext(schedule: ActiveSchedule, nextRunAt: Date, generation: number): void {
		if (this.disposed || generation !== this.generation) {
			return;
		}
		if (schedule.timer) {
			clearTimeout(schedule.timer);
		}
		schedule.nextRunAt = nextRunAt;
		schedule.timerDueAt = nextRunAt;
		const delayMs = Math.max(0, nextRunAt.getTime() - this.now().getTime());
		const clampedDelayMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
		schedule.timer = setTimeout(() => {
			schedule.timer = undefined;
			this.handleTimer(schedule, generation);
		}, clampedDelayMs);
	}

	private handleTimer(schedule: ActiveSchedule, generation: number): void {
		if (this.disposed || generation !== this.generation) {
			return;
		}
		const dueAt = schedule.timerDueAt;
		if (dueAt && dueAt.getTime() > this.now().getTime()) {
			this.scheduleNext(schedule, dueAt, generation);
			return;
		}
		if (schedule.running) {
			schedule.pending = true;
			return;
		}
		void this.runSchedule(schedule, generation);
	}

	private async runSchedule(schedule: ActiveSchedule, generation: number): Promise<void> {
		if (this.disposed || generation !== this.generation || schedule.running) {
			return;
		}

		const runId = randomUUID();
		const runStartedAt = this.now();
		const abortController = new AbortController();
		schedule.running = true;
		schedule.pending = false;
		schedule.runAbortController = abortController;
		this.scheduleNext(schedule, this.calculateNextRunAt(schedule, runStartedAt), generation);

		const exec = async (
			command: string,
			args: string[],
			options?: ScheduleExecOptions,
		): Promise<ScheduleExecResult> => {
			const result = await execCommand(command, args, this.cwd, {
				timeout: options?.timeout ?? DEFAULT_EXEC_TIMEOUT_MS,
				signal: abortController.signal,
			});
			const stdout = truncateOutput(result.stdout);
			const stderr = truncateOutput(result.stderr);
			return {
				stdout: stdout.value,
				stderr: stderr.value,
				code: result.code,
				killed: result.killed,
				truncated: stdout.truncated || stderr.truncated,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
			};
		};

		const notifyAgent = async (input: ScheduleNotifyAgentInput): Promise<void> => {
			if (this.disposed || generation !== this.generation || abortController.signal.aborted) {
				return;
			}
			if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
				throw new Error("notifyAgent summary must be a non-empty string");
			}
			const notification: ScheduleNotification = {
				scheduleName: schedule.definition.name,
				runId,
				timestamp: this.now().toISOString(),
				summary: input.summary.trim(),
				message: input.message,
				data: input.data,
			};
			await this.onNotification(notification, {
				triggerTurn: input.triggerTurn ?? false,
				deliverAs: input.deliverAs,
			});
		};

		try {
			await schedule.definition.run({
				cwd: this.cwd,
				now: runStartedAt,
				scheduleName: schedule.definition.name,
				runId,
				signal: abortController.signal,
				exec,
				notifyAgent,
			});
			if (!abortController.signal.aborted) {
				schedule.lastStatus = "success";
				schedule.lastError = undefined;
			}
		} catch (error) {
			if (!abortController.signal.aborted || !isAbortError(error)) {
				schedule.lastStatus = "error";
				schedule.lastError = errorMessage(error);
			}
		} finally {
			schedule.lastRunAt = runStartedAt;
			schedule.running = false;
			schedule.runAbortController = undefined;
			if (!this.disposed && generation === this.generation && schedule.pending) {
				schedule.pending = false;
				void this.runSchedule(schedule, generation);
			}
		}
	}

	private toStatus(schedule: ActiveSchedule): ScheduleStatus {
		return {
			name: schedule.definition.name,
			description: schedule.definition.description,
			sourceFile: schedule.sourceFile,
			trigger: schedule.triggerDescription,
			state: "loaded",
			enabled: true,
			nextRunAt: schedule.nextRunAt?.toISOString(),
			lastRunAt: schedule.lastRunAt?.toISOString(),
			lastStatus: schedule.lastStatus,
			running: schedule.running,
			pending: schedule.pending,
			lastError: schedule.lastError,
		};
	}
}
