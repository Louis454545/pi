import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

describe("edit tool input", () => {
	it("exposes only the edits array public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).toHaveProperty("edits");
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});

	it("parses edits from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "not json",
		});
	});
});
