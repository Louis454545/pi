import { describe, expect, test } from "vitest";
import { type ChangelogEntry, normalizeChangelogLinks } from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Usage](README.md#usage)",
			"[Extensions](docs/extensions.md)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Usage](https://github.com/earendil-works/morgan/blob/v0.79.0/packages/morgan-agent/README.md#usage)",
				"[Extensions](https://github.com/earendil-works/morgan/blob/v0.79.0/packages/morgan-agent/docs/extensions.md)",
				"[Examples](https://github.com/earendil-works/morgan/tree/v0.79.0/packages/morgan-agent/examples/extensions/)",
				"[Root README](https://github.com/earendil-works/morgan/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("pins floating Morgan repository source URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/morgan/pull/5167)",
			"[Agent README](https://github.com/earendil-works/morgan/blob/main/packages/agent/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/earendil-works/morgan/pull/5167)",
				"[Agent README](https://github.com/earendil-works/morgan/blob/v0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});
