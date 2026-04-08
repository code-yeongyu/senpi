import { describe, expect, test } from "vitest";
import { buildPoliciesSection } from "../../src/core/dynamic-prompt/policies.js";

describe("buildPoliciesSection", () => {
	test("includes language-agnostic hard blocks", () => {
		const result = buildPoliciesSection();

		expect(result).toContain("## Policies");
		expect(result).toContain("### Hard Blocks");
		expect(result).toContain("git commit");
		expect(result).toContain("speculate");
	});

	test("includes language-agnostic anti-patterns", () => {
		const result = buildPoliciesSection();

		expect(result).toContain("### Anti-Patterns");
		expect(result).toContain("failing tests");
		expect(result).toContain("shotgun debugging");
	});

	test("does not hardcode TypeScript-specific rules", () => {
		const result = buildPoliciesSection();

		expect(result).not.toContain("as any");
		expect(result).not.toContain("ts-ignore");
		expect(result).not.toContain("@ts-");
	});

	test("does not hardcode language-specific error handling constructs", () => {
		const result = buildPoliciesSection();

		expect(result).not.toContain("`catch`");
		expect(result).not.toContain("empty catch");
	});

	test("returns non-empty string", () => {
		const result = buildPoliciesSection();

		expect(result.length).toBeGreaterThan(0);
	});
});
