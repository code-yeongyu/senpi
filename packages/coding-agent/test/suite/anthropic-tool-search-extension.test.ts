import { afterEach, describe, expect, it, vi } from "vitest";
import { addAnthropicToolSearchToPayload } from "../../src/core/extensions/builtin/anthropic-tool-search/index.js";

const TOOL_SEARCH_ENV = "PI_ANTHROPIC_TOOL_SEARCH";

afterEach(() => {
	vi.unstubAllEnvs();
	delete process.env[TOOL_SEARCH_ENV];
});

describe("anthropic-tool-search builtin extension", () => {
	it("is a no-op when model api is not anthropic-messages", () => {
		vi.stubEnv(TOOL_SEARCH_ENV, "both");
		const payload = {
			tools: [{ name: "some_tool", description: "function tool" }],
		};

		const result = addAnthropicToolSearchToPayload("openai-responses", payload);

		expect(result).toBe(payload);
	});

	it("is a no-op when env var is unset", () => {
		const payload = {
			tools: [{ name: "some_tool", description: "function tool" }],
		};

		const result = addAnthropicToolSearchToPayload("anthropic-messages", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual(payload.tools);
	});

	it("is a no-op when env var is off", () => {
		vi.stubEnv(TOOL_SEARCH_ENV, "off");
		const payload = {
			tools: [{ name: "some_tool", description: "function tool" }],
		};

		const result = addAnthropicToolSearchToPayload("anthropic-messages", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual(payload.tools);
	});

	it("injects regex tool only when env var is regex", () => {
		vi.stubEnv(TOOL_SEARCH_ENV, "regex");

		const result = addAnthropicToolSearchToPayload("anthropic-messages", { tools: [] }) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual([{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }]);
	});

	it("injects bm25 tool only when env var is bm25", () => {
		vi.stubEnv(TOOL_SEARCH_ENV, "bm25");

		const result = addAnthropicToolSearchToPayload("anthropic-messages", { tools: [] }) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual([{ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" }]);
	});

	it("injects both tools when env var is both", () => {
		vi.stubEnv(TOOL_SEARCH_ENV, "both");

		const result = addAnthropicToolSearchToPayload("anthropic-messages", { tools: [] }) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(result.tools).toEqual([
			{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
			{ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
		]);
	});

	it("treats invalid env values as off and does not throw", () => {
		vi.stubEnv(TOOL_SEARCH_ENV, "garbage-value");
		const payload = {
			tools: [{ name: "some_tool", description: "function tool" }],
		};

		expect(() => addAnthropicToolSearchToPayload("anthropic-messages", payload)).not.toThrow();
		expect(addAnthropicToolSearchToPayload("anthropic-messages", payload)).toEqual({
			tools: [{ name: "some_tool", description: "function tool" }],
		});
	});

	it("dedupes existing native tools and adds only missing ones in both mode", () => {
		vi.stubEnv(TOOL_SEARCH_ENV, "both");
		const payload = {
			tools: [{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }, { name: "other_tool" }],
		};

		const result = addAnthropicToolSearchToPayload("anthropic-messages", payload) as {
			tools: Array<Record<string, unknown>>;
		};

		const regexTools = result.tools.filter((tool) => tool.name === "tool_search_tool_regex");
		const bm25Tools = result.tools.filter((tool) => tool.name === "tool_search_tool_bm25");
		expect(regexTools).toHaveLength(1);
		expect(bm25Tools).toHaveLength(1);
		expect(bm25Tools[0]).toEqual({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
	});
});
