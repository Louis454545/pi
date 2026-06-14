import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.MORGAN_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.MORGAN_EXPERIMENTAL;
		} else {
			process.env.MORGAN_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when MORGAN_EXPERIMENTAL is unset", () => {
		delete process.env.MORGAN_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MORGAN_EXPERIMENTAL is empty", () => {
		process.env.MORGAN_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when MORGAN_EXPERIMENTAL is set to 1", () => {
		process.env.MORGAN_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when MORGAN_EXPERIMENTAL is set to 0", () => {
		process.env.MORGAN_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MORGAN_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.MORGAN_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
