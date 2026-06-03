import type { TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { SubagentNotification } from "../../../core/agent-session.ts";
import type { BackgroundTaskNotification, MonitorEventNotification } from "../../../core/background-tasks.ts";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import type { ScheduleNotification } from "../../../core/schedules/index.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(this.message, { expanded: this._expanded }, theme);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();

		if (this.renderBuiltinNotification()) {
			return;
		}

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}

	private renderBuiltinNotification(): boolean {
		switch (this.message.customType) {
			case "task_notification":
				if (!isBackgroundTaskNotification(this.message.details)) {
					return false;
				}
				this.renderNotificationBlock("task", this.message.details.summary, [
					["status", this.message.details.status],
					["task", this.message.details.taskId],
					["output", this.message.details.outputFile],
					["exit", this.message.details.exitCode?.toString()],
				]);
				return true;
			case "monitor_event":
				if (!isMonitorEventNotification(this.message.details)) {
					return false;
				}
				this.renderNotificationBlock("monitor", this.message.details.summary, [
					["task", this.message.details.taskId],
					["output", this.message.details.outputFile],
					["events", this.message.details.events.length.toString()],
				]);
				for (const event of this.message.details.events) {
					this.box.addChild(new Text(theme.fg("customMessageText", `- ${event}`), 0, 0));
				}
				return true;
			case "subagent_notification":
				if (!isSubagentNotification(this.message.details)) {
					return false;
				}
				this.renderNotificationBlock(`subagent:${this.message.details.name}`, this.message.details.summary, [
					["status", this.message.details.status],
					["task", this.message.details.taskId],
					["trace", this.message.details.sessionFile],
				]);
				if (this.message.details.message) {
					this.box.addChild(new Spacer(1));
					this.box.addChild(
						new Markdown(this.message.details.message, 0, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("customMessageText", text),
						}),
					);
				}
				return true;
			case "schedule_notification":
				if (!isScheduleNotification(this.message.details)) {
					return false;
				}
				this.renderNotificationBlock(
					`schedule:${this.message.details.scheduleName}`,
					this.message.details.summary,
					[
						["run", this.message.details.runId],
						["time", this.message.details.timestamp],
					],
				);
				if (this.message.details.message) {
					this.box.addChild(new Spacer(1));
					this.box.addChild(
						new Markdown(this.message.details.message, 0, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("customMessageText", text),
						}),
					);
				}
				return true;
			default:
				return false;
		}
	}

	private renderNotificationBlock(
		labelText: string,
		summary: string,
		fields: Array<[string, string | undefined]>,
	): void {
		const label = theme.fg("customMessageLabel", `\x1b[1m[${labelText}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Text(theme.fg("customMessageText", summary), 0, 0));
		for (const [name, value] of fields) {
			if (!value) {
				continue;
			}
			this.box.addChild(new Text(theme.fg("dim", `${name}: `) + theme.fg("customMessageText", value), 0, 0));
		}
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
	return value === undefined || typeof value === "number";
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isBackgroundTaskNotification(value: unknown): value is BackgroundTaskNotification {
	return (
		isObject(value) &&
		isString(value.taskId) &&
		isString(value.outputFile) &&
		isString(value.status) &&
		isString(value.summary) &&
		isOptionalNumber(value.exitCode)
	);
}

function isMonitorEventNotification(value: unknown): value is MonitorEventNotification {
	return (
		isObject(value) &&
		isString(value.taskId) &&
		isString(value.outputFile) &&
		Array.isArray(value.events) &&
		value.events.every(isString) &&
		isString(value.summary)
	);
}

function isSubagentNotification(value: unknown): value is SubagentNotification {
	return (
		isObject(value) &&
		isString(value.name) &&
		isString(value.taskId) &&
		isOptionalString(value.sessionFile) &&
		isOptionalString(value.parentSessionFile) &&
		isString(value.status) &&
		isString(value.summary) &&
		isOptionalString(value.message)
	);
}

function isScheduleNotification(value: unknown): value is ScheduleNotification {
	return (
		isObject(value) &&
		isString(value.scheduleName) &&
		isString(value.runId) &&
		isString(value.timestamp) &&
		isString(value.summary) &&
		isOptionalString(value.message)
	);
}
