import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceLoader } from "../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("AgentSession reload tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("enables reload by default and advertises it in the system prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toContain("reload");
		expect(harness.session.systemPrompt).toContain(
			"- reload: Reload pi runtime resources after agent-affecting edits",
		);
		expect(harness.session.systemPrompt).toContain("call reload before you say the work is complete");
		expect(harness.session.systemPrompt).toContain(
			"If a user asks for a new slash command, extension, skill, theme, keybinding, or prompt behavior",
		);
	});

	it("respects tool exclusion for reload", async () => {
		const harness = await createHarness({ excludedToolNames: ["reload"] });
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).not.toContain("reload");
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("reload");
		expect(harness.session.systemPrompt).not.toContain("- reload:");
	});

	it("reloads resources after the reload tool result and continues with the refreshed prompt", async () => {
		const lifecycleEvents: string[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("session_start", async (event) => {
					lifecycleEvents.push(`start:${event.reason}`);
				});
				pi.on("session_shutdown", async (event) => {
					lifecycleEvents.push(`shutdown:${event.reason}`);
				});
			},
		]);
		let reloadCount = 0;
		const baseResourceLoader = createTestResourceLoader({ extensionsResult });
		const resourceLoader: ResourceLoader = {
			...baseResourceLoader,
			getAppendSystemPrompt: () => [`reload-count:${reloadCount}`],
			reload: async () => {
				reloadCount++;
			},
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		const responses: Array<AssistantMessage | ((context: Context) => AssistantMessage)> = [
			fauxAssistantMessage(fauxToolCall("reload", {}), { stopReason: "toolUse" }),
			(context) =>
				fauxAssistantMessage((context.systemPrompt ?? "").includes("reload-count:1") ? "reloaded" : "stale"),
		];
		let responseIndex = 0;
		const streamFn: StreamFn = async (_model, context) => {
			const stream = createAssistantMessageEventStream();
			const response = responses[responseIndex++];
			const message = typeof response === "function" ? response(context) : response;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
				stream.end(message);
			});
			return stream;
		};
		harness.session.agent.streamFn = streamFn;

		await harness.session.prompt("reload runtime resources");

		expect(reloadCount).toBe(1);
		expect(harness.eventsOfType("session_reloaded")).toHaveLength(1);
		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
		expect(getAssistantTexts(harness).filter((text) => text.length > 0)).toEqual(["reloaded"]);
		expect(harness.session.systemPrompt).toContain("reload-count:1");
		const reloadResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "reload",
		);
		expect(reloadResult?.role).toBe("toolResult");
		if (!reloadResult || reloadResult.role !== "toolResult") {
			throw new Error("reload tool result missing");
		}
		const firstContent = reloadResult.content[0];
		expect(firstContent?.type === "text" ? firstContent.text : "").toContain("Reload scheduled");
	});
});
