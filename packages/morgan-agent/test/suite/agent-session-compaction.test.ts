import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@earendil-works/morgan-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (_model, context) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const response =
				callCount === 1
					? fauxAssistantMessage(
							fauxToolCall("write", {
								path: extractDreamPath(getLastUserText(context.messages), "Compaction summary output file"),
								content: summary,
							}),
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("dream complete");
			const message: AssistantMessage = {
				...response,
				api: harness.getModel().api,
				provider: harness.getModel().provider,
				model: harness.getModel().id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function getLastUserText(messages: Array<{ role: string; content: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.filter((part): part is { type: "text"; text: string } => part?.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
	}
	return "";
}

function extractDreamPath(prompt: string, label: string): string {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = prompt.match(new RegExp(`${escaped}: (.+)`));
	if (!match) {
		throw new Error(`Missing ${label} in dream prompt`);
	}
	return match[1]!.trim();
}

function dreamWriteResponses(summary: string, snapshot?: string) {
	return [
		(context: { messages: Array<{ role: string; content: unknown }> }) => {
			const dreamPrompt = getLastUserText(context.messages);
			const toolCalls = [
				fauxToolCall("write", {
					path: extractDreamPath(dreamPrompt, "Compaction summary output file"),
					content: summary,
				}),
			];
			if (snapshot) {
				toolCalls.push(
					fauxToolCall("write", {
						path: extractDreamPath(dreamPrompt, "Durable memory snapshot file"),
						content: snapshot,
					}),
				);
			}
			return fauxAssistantMessage(toolCalls, { stopReason: "toolUse" });
		},
		fauxAssistantMessage("dream complete"),
	];
}

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage(
		createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: now - 500,
		}),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using the summary file written by the dream", async () => {
		const dreamEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.on("session_before_dream", async (event) => {
						dreamEvents.push(`${event.type}:${event.reason}`);
					});
					morgan.on("session_dream", async (event) => {
						dreamEvents.push(`${event.type}:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			...dreamWriteResponses("summary from dream file"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(result.summary).toBe("summary from dream file");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(dreamEvents).toEqual(["session_before_dream:manual", "session_dream:manual"]);
	});

	it("does not persist internal dream messages or tool results", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			...dreamWriteResponses("summary from internal dream"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.compact();

		const entries = harness.sessionManager.getEntries();
		expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(
			harness.session.messages.some(
				(message) => message.role === "user" && getLastUserText([message]).includes("internal dreaming"),
			),
		).toBe(false);
	});

	it("lets the dream update snapshot memory for the next provider request", async () => {
		const snapshot = [
			"# User Bio",
			"",
			"- The user prefers compact implementation notes.",
			"",
			"# User Interaction Metadata",
			"",
			"- (none)",
			"",
			"# User Knowledge Memories",
			"",
			"- Preference: compact implementation notes.",
			"",
		].join("\n");
		const harness = await createHarness();
		harnesses.push(harness);
		let nextSystemPrompt = "";
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			...dreamWriteResponses("summary with memory update", snapshot),
			(context) => {
				nextSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("after memory");
			},
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.compact();
		await harness.session.prompt("after compact");

		expect(readFileSync(join(harness.tempDir, "memory", "snapshot.md"), "utf-8")).toContain(
			"compact implementation notes",
		);
		expect(nextSystemPrompt).toContain("compact implementation notes");
	});

	it("compacts when active tools are read-only by injecting write/edit for the dream turn only", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const activeToolsBefore = harness.session.agent.state.tools.map((tool) => tool.name);
		harness.setResponses(dreamWriteResponses("summary from read-only session"));

		const result = await harness.session.compact();

		expect(result.summary).toBe("summary from read-only session");
		expect(harness.session.agent.state.tools.map((tool) => tool.name)).toEqual(activeToolsBefore);
	});

	it("fails clearly when builtin write/edit tools are not registered", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read"],
			excludedToolNames: ["write", "edit"],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow(
			"Cannot dream-compact: builtin write/edit tools are not registered.",
		);
	});

	it("recovers from overflow when active tools are read-only", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses(dreamWriteResponses("overflow recovery summary"));
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		const willRetry = await sessionInternals._runAutoCompaction("overflow", true);

		expect(willRetry).toBe(true);
		expect(compactionErrors).toHaveLength(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("fails clearly when the context is already too large for dreaming", async () => {
		const harness = await createHarness({ models: [{ id: "tiny-context", contextWindow: 50 }] });
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow(
			"Cannot dream-compact: context is already too large for an internal compaction turn.",
		);
	});

	it("does not let dreaming mutate arbitrary workspace files", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		const forbiddenPath = join(harness.tempDir, "forbidden.txt");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: forbiddenPath, content: "bad write" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await expect(harness.session.compact()).rejects.toThrow("summary output file is empty");

		expect(existsSync(forbiddenPath)).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("leaves queued follow-up messages queued during dreaming", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses(dreamWriteResponses("summary while queued"));

		await harness.session.followUp("queued follow-up");
		await harness.session.compact();

		expect(harness.session.getFollowUpMessages()).toEqual(["queued follow-up"]);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toBe("summary from custom stream");
		expect(getStreamCallCount()).toBe(2);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(getStreamCallCount()).toBe(2);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(morgan) => {
					morgan.on("session_before_dream", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			...dreamWriteResponses("auto compacted"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction("summary", firstKeptEntryId, staleAssistant.usage.totalTokens, undefined);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction("summary", firstKeptEntryId, keptAssistant.usage.totalTokens, undefined);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
