import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { API_FACTS, apiFacts } from "../../src/core/egress/api-table.ts";

describe("api table", () => {
	it("classifies every api the builtin registry serves", () => {
		const registered = getApiProviders().map((provider) => provider.api);
		expect(registered.length).toBeGreaterThan(0);
		expect(registered.filter((api) => !Object.hasOwn(API_FACTS, api))).toEqual([]);
	});

	it.each([undefined, "extension-registered-api", "toString", "__proto__"])(
		"routes the unlisted api %s to a device with unknown injection and logging",
		(api) => {
			expect(apiFacts(api)).toEqual({
				capability: "ambient-credential",
				fetchInjection: "unknown",
				sdkLogging: { kind: "unknown" },
			});
		},
	);

	it("returns the tabled facts for a listed api", () => {
		expect(apiFacts("anthropic-messages")).toBe(API_FACTS["anthropic-messages"]);
		expect(apiFacts("cursor-agent").capability).toBe("callback-stream");
	});
});
