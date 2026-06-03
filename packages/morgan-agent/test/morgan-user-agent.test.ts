import { describe, expect, it } from "vitest";
import { getMorganUserAgent } from "../src/utils/morgan-user-agent.ts";

describe("getMorganUserAgent", () => {
	it("formats the user agent expected by morgan.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getMorganUserAgent("1.2.3");

		expect(userAgent).toBe(`morgan/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^morgan\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
