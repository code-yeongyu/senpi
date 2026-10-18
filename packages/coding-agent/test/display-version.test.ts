import { describe, expect, it } from "vitest";

import { formatDisplayVersion } from "../src/modes/interactive/version-label.ts";

describe("formatDisplayVersion", () => {
	it("prefixes release versions with v", () => {
		expect(formatDisplayVersion("5.0.1")).toBe("v5.0.1");
		expect(formatDisplayVersion("2026.8.26-2")).toBe("v2026.8.26-2");
	});

	it("renders branded build labels verbatim", () => {
		const label = "omo@c6e7dd7 2026-09-04 10:17 +09:00 · senpi@7fd18df 2026-09-04 10:49 +09:00";
		expect(formatDisplayVersion(label)).toBe(label);
	});
});
