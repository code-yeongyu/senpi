import { describe, expect, test } from "vitest";
import { buildPoliciesSection } from "../../src/core/dynamic-prompt/policies.js";

describe("buildPoliciesSection", () => {
	test("includes hard blocks", () => {
		const result = buildPoliciesSection();

		expect(result).toContain("as any");
		expect(result).toContain("ts-ignore");
	});

	test("includes anti-patterns", () => {
		const result = buildPoliciesSection();

		expect(result).toContain("catch");
	});

	test("returns non-empty string", () => {
		const result = buildPoliciesSection();

		expect(result.length).toBeGreaterThan(0);
	});
});
