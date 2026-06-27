import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriggerEmit } from "@earendil-works/morgan-agent";
import type { AgentTool } from "@earendil-works/morgan-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/morgan-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

async function waitForCondition(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for condition");
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `morgan-proactive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

function createWaitingTool(): {
	tool: AgentTool;
	waitForStart: Promise<void>;
	release: () => void;
} {
	let releaseTool: (() => void) | undefined;
	let resolveStart: (() => void) | undefined;
	const waitForStart = new Promise<void>((resolve) => {
		resolveStart = resolve;
	});
	const releasePromise = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			resolveStart?.();
			await releasePromise;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	return {
		tool,
		waitForStart,
		release: () => releaseTool?.(),
	};
}

describe("AgentSession proactive triggers", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("registers triggers and reports duplicate trigger diagnostics", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({ name: "same", start: () => {} });
				},
				(morgan) => {
					morgan.registerTrigger({ name: "same", start: () => {} });
				},
			],
		});
		harnesses.push(harness);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const triggers = harness.session.extensionRunner.getRegisteredTriggers();

		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.definition.name).toBe("same");
		expect(harness.session.extensionRunner.getTriggerDiagnostics()[0]?.message).toContain("conflict");
		warnSpy.mockRestore();
	});

	it("starts triggers on session_start, cleans them up on reload, and ignores stale emit", async () => {
		let starts = 0;
		let cleanups = 0;
		let staleEmit: TriggerEmit | undefined;
		let activeEmit: TriggerEmit | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "lifecycle",
						start: (_ctx, emit) => {
							starts++;
							if (!staleEmit) {
								staleEmit = emit;
							}
							activeEmit = emit;
							return () => {
								cleanups++;
							};
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});
		expect(starts).toBe(1);

		await harness.session.reload();
		expect(starts).toBe(2);
		expect(cleanups).toBe(1);

		staleEmit?.({ eventId: "stale", summary: "stale event" });
		activeEmit?.({ eventId: "active", summary: "active event" });
		await waitForCondition(() => harness.eventsOfType("proactive_trigger_event").length === 1);

		expect(harness.eventsOfType("proactive_trigger_event")[0]?.notification.eventId).toBe("active");
	});

	it("reports trigger startup and malformed emit errors through extension errors", async () => {
		const errors: Array<{ event: string; error: string }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "bad-start",
						start: () => {
							throw new Error("startup failed");
						},
					});
					morgan.registerTrigger({
						name: "bad-emit",
						start: (_ctx, emit) => {
							emit({ eventId: "empty", summary: "" });
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({
			onError: (error) => {
				errors.push({ event: error.event, error: error.error });
			},
		});

		expect(errors).toEqual(
			expect.arrayContaining([
				{ event: "trigger_start", error: "startup failed" },
				{
					event: "trigger_emit",
					error: "Trigger 'bad-emit' emitted an event with an empty summary. Skipping.",
				},
			]),
		);
		expect(harness.eventsOfType("proactive_trigger_event")).toHaveLength(0);
	});

	it("persists hidden trigger events and starts a proactive turn while idle", async () => {
		let emit: TriggerEmit | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "idle",
						start: (_ctx, triggerEmit) => {
							emit = triggerEmit;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled proactive event")]);
		await harness.session.bindExtensions({});

		emit?.({ eventId: "idle-1", summary: "idle event", payload: { ok: true } });
		await waitForCondition(() => getAssistantTexts(harness).includes("handled proactive event"));

		const customMessage = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "proactive_trigger_event",
		);
		if (!customMessage || customMessage.role !== "custom") {
			throw new Error("Expected proactive trigger custom message");
		}
		expect(customMessage.display).toBe(false);
		expect(customMessage.details).toMatchObject({
			triggerName: "idle",
			eventId: "idle-1",
			summary: "idle event",
			payload: { ok: true },
		});
	});

	it("delivers trigger events into the running turn while the agent is busy", async () => {
		let emit: TriggerEmit | undefined;
		const waiting = createWaitingTool();
		const harness = await createHarness({
			tools: [waiting.tool],
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "busy",
						start: (_ctx, triggerEmit) => {
							emit = triggerEmit;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original complete"),
		]);
		await harness.session.bindExtensions({});

		const promptPromise = harness.session.prompt("start");
		await waiting.waitForStart;
		emit?.({ eventId: "busy-1", summary: "busy event" });
		// The session event is emitted synchronously, even while the agent is busy.
		expect(harness.eventsOfType("proactive_trigger_event")).toHaveLength(1);
		expect(harness.eventsOfType("proactive_trigger_event")[0]?.notification.eventId).toBe("busy-1");

		waiting.release();
		await promptPromise;

		expect(getAssistantTexts(harness)).toContain("original complete");
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "proactive_trigger_event",
			),
		).toBe(true);
	});

	it("does not expose a notify_user tool during proactive turns", async () => {
		let emit: TriggerEmit | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "no-notify",
						start: (_ctx, triggerEmit) => {
							emit = triggerEmit;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled without notify_user")]);
		await harness.session.bindExtensions({});

		const toolsBefore = harness.session.getActiveToolNames().slice();
		emit?.({ eventId: "no-notify-1", summary: "event" });
		await waitForCondition(() => getAssistantTexts(harness).includes("handled without notify_user"));

		expect(harness.session.getActiveToolNames()).not.toContain("notify_user");
		expect(harness.session.getActiveToolNames()).toEqual(toolsBefore);
	});

	it("runs a cron/interval scheduled trigger and delivers its event", async () => {
		let runs = 0;
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "scheduled",
						schedule: { intervalMs: 1000 },
						run: (_ctx, emit) => {
							runs++;
							emit({ summary: `scheduled run ${runs}` });
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("scheduled handled"), fauxAssistantMessage("scheduled handled")]);
		await harness.session.bindExtensions({});

		await waitForCondition(() => harness.eventsOfType("proactive_trigger_event").length >= 1, 4000);
		expect(harness.eventsOfType("proactive_trigger_event")[0]?.notification.triggerName).toBe("scheduled");
	});

	it("reports a scheduled trigger without a run function as a diagnostic", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({ name: "broken-schedule", schedule: { intervalMs: 1000 } });
				},
			],
		});
		harnesses.push(harness);

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const triggers = harness.session.extensionRunner.getRegisteredTriggers();
		expect(triggers).toHaveLength(0);
		expect(harness.session.extensionRunner.getTriggerDiagnostics()[0]?.message).toContain("schedule + run()");
		warnSpy.mockRestore();
	});

	it("runs triggers without UI bindings", async () => {
		let emit: TriggerEmit | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.registerTrigger({
						name: "rpc",
						start: (_ctx, triggerEmit) => {
							emit = triggerEmit;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("rpc handled")]);
		await harness.session.bindExtensions({});

		emit?.({ eventId: "rpc-1", summary: "rpc event" });
		await waitForCondition(() => getAssistantTexts(harness).includes("rpc handled"));
		expect(harness.eventsOfType("proactive_trigger_event")[0]?.notification.triggerName).toBe("rpc");
	});

	it("discovers triggers from normal configured extension locations", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const configuredExtension = join(tempDir, "plain-extension.ts");
		writeFileSync(
			configuredExtension,
			`
				export default function(morgan) {
					morgan.registerTrigger({ name: "plain", start: () => {} });
				}
			`,
		);
		const loaded = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			additionalExtensionPaths: [configuredExtension],
		});
		await loaded.reload();

		expect(loaded.getExtensions().extensions.flatMap((extension) => [...extension.triggers.keys()])).toEqual([
			"plain",
		]);
	});
});
