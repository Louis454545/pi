import { describe, expect, it } from "vitest";
import type { SessionManager } from "../src/core/session-manager.ts";
import { formatResumeCommand } from "../src/modes/interactive/interactive-mode.ts";

function createSessionManager(): SessionManager {
	return {
		isPersisted: () => true,
		getSessionFile: () => "/tmp/morgan-sessions/global/conversation.jsonl",
		getSessionId: () => "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
		getSessionDir: () => "/tmp/morgan-sessions/global",
		usesDefaultSessionDir: () => false,
	} as unknown as SessionManager;
}

describe("formatResumeCommand", () => {
	it("does not emit hidden --session resume commands", () => {
		expect(formatResumeCommand(createSessionManager())).toBeUndefined();
	});
});
