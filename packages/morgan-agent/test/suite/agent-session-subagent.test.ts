import type { Context } from "@earendil-works/morgan-ai";
import { fauxAssistantMessage } from "@earendil-works/morgan-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

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

function contextText(context: Context): string {
	return context.messages
		.map((message) => {
			const content = message.content;
			if (typeof content === "string") {
				return content;
			}
			return content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		})
		.join("\n");
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for condition");
}

describe("AgentSession subagents", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("starts a subagent and injects the completion notification into the parent", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		let notificationReachedParent = false;

		harness.setResponses([
			fauxAssistantMessage("child answer"),
			(context) => {
				notificationReachedParent = contextHasXmlTag(context, "<subagent-notification>");
				return fauxAssistantMessage("parent saw subagent notification");
			},
		]);

		const result = await harness.session.handleSubagentToolAction({
			name: "worker",
			message: "inspect the repo",
		});
		await harness.session.waitForSubagents();

		expect(result.taskId).toMatch(/^subagent_/);
		expect(result.sessionFile).toBeUndefined();
		expect(result.parentSessionFile).toBe(harness.session.sessionFile);
		expect(result.message).toContain("Trace file:");

		const notifications = harness.eventsOfType("subagent_notification");
		expect(notifications).toHaveLength(1);
		expect(notifications[0].notification.name).toBe("worker");
		expect(notifications[0].notification.status).toBe("completed");
		expect(notifications[0].notification.message).toBe("child answer");
		expect(notificationReachedParent).toBe(true);
	});

	it("sends steering messages to a running subagent", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		let releaseFirstResponse: (() => void) | undefined;
		let secondContext: Context | undefined;

		harness.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					releaseFirstResponse = resolve;
				});
				return fauxAssistantMessage("first child turn");
			},
			(context) => {
				secondContext = context;
				return fauxAssistantMessage("second child turn");
			},
			fauxAssistantMessage("parent saw child completion"),
		]);

		const startResult = await harness.session.handleSubagentToolAction({
			name: "researcher",
			message: "start research",
		});
		await waitFor(() => releaseFirstResponse !== undefined);

		const sendResult = await harness.session.handleSubagentToolAction({
			action: "send",
			name: "researcher",
			message: "Additional detail: inspect package metadata.",
		});
		releaseFirstResponse?.();
		await harness.session.waitForSubagents();

		expect(startResult.status).toBe("running");
		expect(sendResult.message).toBe('Message sent to subagent "researcher".');
		expect(secondContext).toBeDefined();
		expect(contextText(secondContext!)).toContain("Additional detail: inspect package metadata.");
	});

	it("rejects non-string action values", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		await expect(
			harness.session.handleSubagentToolAction({
				action: { reason: "start subagent" },
				name: "worker",
				message: "inspect the repo",
			}),
		).rejects.toThrow('subagent action must be omitted or one of the literal strings "send", "list", or "status".');
	});
});
