import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("built-in slash commands", () => {
	it("hides normal multi-session commands and exposes global conversation commands", () => {
		const commandNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

		expect(commandNames.has("resume")).toBe(false);
		expect(commandNames.has("fork")).toBe(false);
		expect(commandNames.has("clone")).toBe(false);
		expect(commandNames.has("new")).toBe(false);
		expect(commandNames.has("reset")).toBe(true);
		expect(commandNames.has("cwd")).toBe(true);
		expect(commandNames.has("import")).toBe(true);
	});
});
