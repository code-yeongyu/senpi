import { describe, expect, test } from "vitest";
import { buildIntentGate } from "../../src/core/dynamic-prompt/intent-gate.ts";
import type { AvailableTool } from "../../src/core/dynamic-prompt/types.ts";

describe("buildIntentGate", () => {
	test("adds search trigger when search tools are available", () => {
		const tools: AvailableTool[] = [{ name: "grep", category: "search" }];
		const result = buildIntentGate({ tools });

		expect(result).toContain("grep");
	});

	test("omits the search trigger without search tools", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).not.toContain("Specialized search available this turn");
	});
});
