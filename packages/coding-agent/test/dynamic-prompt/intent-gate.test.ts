import { describe, expect, test } from "vitest";
import { buildIntentGate } from "../../src/core/dynamic-prompt/intent-gate.ts";
import type { AvailableTool } from "../../src/core/dynamic-prompt/types.ts";

describe("buildIntentGate", () => {
	test("includes intent routing rules", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("## Intent Gate");
		expect(result).toContain("Route by true intent, not surface form");
	});

	test("covers the three intent families", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("Information asks");
		expect(result).toContain("Judgment asks");
		expect(result).toContain("Change asks");
	});

	test("includes scope fidelity rule", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("scope asked");
	});

	test("includes turn-local intent derivation", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("latest user turn");
	});

	test("adds search trigger when search tools are available", () => {
		const tools: AvailableTool[] = [{ name: "grep", category: "search" }];
		const result = buildIntentGate({ tools });

		expect(result).toContain("grep");
	});

	test("omits the search trigger without search tools", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).not.toContain("Specialized search available this turn");
	});

	test("forces intent verbalization with a binding stop condition", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("I read this as");
		expect(result).toContain("I'll stop when");
		expect(result).not.toContain("Keep the routing decision internal");
		expect(result).not.toContain("Do not expose classification labels");
	});

	test("routes common surface forms", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("explain");
		expect(result).toContain("implement");
		expect(result).toContain("error");
		expect(result).toContain("refactor");
	});
});
