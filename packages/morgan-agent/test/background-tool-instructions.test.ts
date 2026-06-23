import { describe, expect, test } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createMonitorToolDefinition } from "../src/core/tools/monitor.ts";
import { createTaskStopToolDefinition } from "../src/core/tools/task-stop.ts";

describe("background tool instructions", () => {
	test("tell monitors to trigger live turns without replacing them with output-file polling", () => {
		const definition = createMonitorToolDefinition(process.cwd());

		expect(definition.description).toContain("live events that can trigger agent turns");
		expect(definition.description).toContain("extra context, diagnosis, verification, or explicit user requests");
		expect(definition.description).toContain("do not repeatedly read or poll that output file");
		expect(definition.description).toContain("preferably unbuffered");
		expect(definition.description).toContain("avoid raw log streams");
		expect(definition.description).toContain("stop or replace it with a better filtered monitor");
		expect(definition.promptSnippet).toContain("do not replace them with output-file polling");
	});

	test("distinguishes background bash completion from live monitor events", () => {
		const definition = createBashToolDefinition(process.cwd());

		expect(definition.description).toContain("only need completion or failure notification");
		expect(definition.description).toContain(
			"Use monitor instead when live output should drive additional Morgan work while the process is still running.",
		);
	});

	test("points task_stop at replacing bad monitors", () => {
		const definition = createTaskStopToolDefinition(process.cwd());

		expect(definition.description).toContain("background task or monitor");
		expect(definition.description).toContain("replace a bad monitor");
		expect(definition.promptSnippet).toContain("monitors");
	});
});
