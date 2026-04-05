import { describe, expect, test } from "vitest";
import { buildIntentGate } from "../../src/core/dynamic-prompt/intent-gate.js";
import type { AvailableTool } from "../../src/core/dynamic-prompt/types.js";

describe("buildIntentGate", () => {
	test("includes intent verbalization table", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("Intent");
		expect(result).toContain("Surface Form");
		expect(result).toContain("True Intent");
	});

	test("includes request classification steps", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("Trivial");
		expect(result).toContain("Explicit");
		expect(result).toContain("Exploratory");
		expect(result).toContain("Open-ended");
		expect(result).toContain("Ambiguous");
	});

	test("includes context-completion gate", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("Context-Completion Gate");
	});

	test("includes turn-local intent reset", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("Turn-Local Intent Reset");
	});

	test("adds lsp trigger when lsp tools are available", () => {
		const tools: AvailableTool[] = [{ name: "lsp_goto_definition", category: "lsp" }];
		const result = buildIntentGate({ tools });

		expect(result).toContain("lsp");
	});

	test("adds ast_grep trigger when ast tools are available", () => {
		const tools: AvailableTool[] = [{ name: "ast_grep_search", category: "ast" }];
		const result = buildIntentGate({ tools });

		expect(result).toContain("ast_grep");
	});

	test("adds search trigger when search tools are available", () => {
		const tools: AvailableTool[] = [{ name: "grep", category: "search" }];
		const result = buildIntentGate({ tools });

		expect(result).toContain("grep");
	});

	test("omits triggers for categories not present", () => {
		const tools: AvailableTool[] = [{ name: "read", category: "other" }];
		const result = buildIntentGate({ tools });

		expect(result).not.toContain("`lsp_*`");
		expect(result).not.toContain("`ast_grep`");
	});

	test("instructs model to verbalize detected intent before acting", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("I detect");
		expect(result).toContain("intent");
		expect(result).toContain("My approach");
	});

	test("includes routing map with surface form to approach mapping", () => {
		const result = buildIntentGate({ tools: [] });

		expect(result).toContain("explain");
		expect(result).toContain("implement");
		expect(result).toContain("error");
		expect(result).toContain("refactor");
	});

	test("includes all triggers when all tool categories present", () => {
		const tools: AvailableTool[] = [
			{ name: "lsp_diagnostics", category: "lsp" },
			{ name: "ast_grep_search", category: "ast" },
			{ name: "grep", category: "search" },
			{ name: "read", category: "other" },
		];
		const result = buildIntentGate({ tools });

		expect(result).toContain("lsp");
		expect(result).toContain("ast_grep");
		expect(result).toContain("grep");
	});
});
