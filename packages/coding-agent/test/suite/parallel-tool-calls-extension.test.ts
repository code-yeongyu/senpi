import { describe, expect, it } from "vitest";
import {
	addParallelToolCallsToPayload,
	PARALLEL_TOOL_CALLS_SECTION,
} from "../../src/core/extensions/builtin/parallel-tool-calls.js";

describe("PARALLEL_TOOL_CALLS_SECTION content", () => {
	it("does not reference phantom lsp_* tools", () => {
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("lsp_goto_definition");
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("lsp_find_references");
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("lsp_diagnostics");
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("lsp_");
	});

	it("does not reference phantom ast_grep tool", () => {
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("ast_grep");
	});

	it("does not reference phantom glob tool", () => {
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("`glob`");
	});

	it("does not hardcode grep tool name (it can be disabled by --tools)", () => {
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("`grep`");
	});

	it("does not hardcode read tool name (it can be disabled by --tools)", () => {
		expect(PARALLEL_TOOL_CALLS_SECTION).not.toContain("`read`");
	});

	it("contains execution strategy content", () => {
		expect(PARALLEL_TOOL_CALLS_SECTION).toContain("Execution Strategy");
		expect(PARALLEL_TOOL_CALLS_SECTION).toContain("Parallel Tool Calls");
	});

	it("contains context breadth guidance", () => {
		expect(PARALLEL_TOOL_CALLS_SECTION).toContain("Context Breadth");
	});
});

describe("parallel-tool-calls builtin extension", () => {
	it("adds parallel_tool_calls for openai completions payloads with tools", () => {
		const payload = {
			model: "gpt-4o-mini",
			tools: [{ type: "function", function: { name: "ping" } }],
		};

		const result = addParallelToolCallsToPayload("openai-completions", payload) as {
			parallel_tool_calls?: boolean;
		};

		expect(result.parallel_tool_calls).toBe(true);
	});

	it("adds parallel_tool_calls for openai responses payloads with tools", () => {
		const payload = {
			model: "gpt-5",
			tools: [{ type: "function", name: "ping", parameters: { type: "object" } }],
		};

		const result = addParallelToolCallsToPayload("openai-responses", payload) as {
			parallel_tool_calls?: boolean;
		};

		expect(result.parallel_tool_calls).toBe(true);
	});

	it("leaves anthropic payloads unchanged", () => {
		const payload = {
			model: "claude-sonnet-4-5",
			tools: [{ name: "ping", input_schema: { type: "object" } }],
		};

		const result = addParallelToolCallsToPayload("anthropic-messages", payload);

		expect(result).toBe(payload);
	});

	it("leaves payloads without tools unchanged", () => {
		const payload = {
			model: "gpt-4o-mini",
		};

		const result = addParallelToolCallsToPayload("openai-completions", payload);

		expect(result).toBe(payload);
	});

	it("preserves explicit parallel_tool_calls values", () => {
		const payload = {
			model: "gpt-4o-mini",
			tools: [{ type: "function", function: { name: "ping" } }],
			parallel_tool_calls: false,
		};

		const result = addParallelToolCallsToPayload("openai-completions", payload);

		expect(result).toBe(payload);
	});
});
