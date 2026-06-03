export type ScheduleDeliveryMode = "steer" | "followUp" | "nextTurn";

export type ScheduleTrigger =
	| {
			cron: string;
			timezone?: string;
	  }
	| {
			intervalMs: number;
	  };

export interface ScheduleExecOptions {
	/** Timeout in milliseconds. Defaults to the scheduler's safe timeout. */
	timeout?: number;
}

export interface ScheduleExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	truncated: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

export interface ScheduleNotifyAgentInput {
	summary: string;
	message?: string;
	data?: unknown;
	triggerTurn?: boolean;
	deliverAs?: ScheduleDeliveryMode;
}

export interface ScheduleRunContext {
	cwd: string;
	now: Date;
	scheduleName: string;
	runId: string;
	signal: AbortSignal;
	exec(command: string, args: string[], options?: ScheduleExecOptions): Promise<ScheduleExecResult>;
	notifyAgent(input: ScheduleNotifyAgentInput): Promise<void>;
}

export interface ScheduleDefinition {
	name: string;
	description?: string;
	trigger: ScheduleTrigger;
	run(ctx: ScheduleRunContext): Promise<void> | void;
}

export function defineSchedule(schedule: ScheduleDefinition): ScheduleDefinition {
	return schedule;
}
