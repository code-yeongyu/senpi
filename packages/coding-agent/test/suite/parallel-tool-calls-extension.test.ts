import { describe, expect, it } from "vitest";
import { addParallelToolCallsToPayload } from "../../src/core/extensions/builtin/parallel-tool-calls.js";

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
