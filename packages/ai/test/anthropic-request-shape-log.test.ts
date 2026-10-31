import { describe, expect, it } from "vitest";
import { logAnthropicRequestShape, REQUEST_SHAPE_LOG_ENV } from "../src/api/anthropic-request-shape-log.ts";

const SECRET_TEXT = "user secret prompt text";

const params = {
	messages: [
		{ role: "user", content: SECRET_TEXT },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: SECRET_TEXT, signature: "sig" },
				{ type: "server_tool_use", id: "srvtoolu_a", name: "web_search", input: { query: SECRET_TEXT } },
				{ type: "tool_use", id: "toolu_b", name: "read", input: { path: SECRET_TEXT } },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: SECRET_TEXT }] },
	],
};

describe("anthropic request shape log (senpi#3727)", () => {
	it("writes roles, block types and tool ids per index without any content", () => {
		// Given: the debug flag points at a log
		const lines: string[] = [];

		// When: a request is logged
		logAnthropicRequestShape(
			{ provider: "anthropic", id: "claude-opus-5-5" },
			params,
			{
				[REQUEST_SHAPE_LOG_ENV]: "/tmp/shape.jsonl",
			},
			(_path, data) => lines.push(data),
		);

		// Then: the skeleton keeps pairing ids and drops every content field
		expect(lines).toHaveLength(1);
		const line = lines[0] ?? "";
		expect(line).not.toContain(SECRET_TEXT);
		expect(JSON.parse(line).messages).toEqual([
			{ index: 0, role: "user", blocks: "string" },
			{
				index: 1,
				role: "assistant",
				blocks: [
					{ type: "thinking" },
					{ type: "server_tool_use", id: "srvtoolu_a" },
					{ type: "tool_use", id: "toolu_b" },
				],
			},
			{ index: 2, role: "user", blocks: [{ type: "tool_result", toolUseId: "toolu_b" }] },
		]);
	});

	it("writes nothing when the flag is unset", () => {
		// Given: no debug flag
		const lines: string[] = [];

		// When: a request is logged
		logAnthropicRequestShape({ provider: "anthropic", id: "claude-opus-5-5" }, params, {}, (_path, data) =>
			lines.push(data),
		);

		// Then: no record is written
		expect(lines).toEqual([]);
	});
});
