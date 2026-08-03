import { sanitizeAnthropicToolPairs as sanitizeAnthropicPayload } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

describe("sanitizeAnthropicPayload", () => {
	it("returns same reference for payload without messages", () => {
		const payload = {};
		expect(sanitizeAnthropicPayload(payload)).toBe(payload);
	});

	it("returns same reference for non-object payloads", () => {
		expect(sanitizeAnthropicPayload(null)).toBeNull();
		expect(sanitizeAnthropicPayload("text")).toBe("text");
		expect(sanitizeAnthropicPayload(42)).toBe(42);
	});

	it("returns same reference when all tool pairs are valid", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "ls", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" }] },
			],
		};

		expect(sanitizeAnthropicPayload(payload)).toBe(payload);
	});

	it("removes a single orphan tool_result block", () => {
		const payload = {
			messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "bad" }] }],
		};

		const result = sanitizeAnthropicPayload(payload) as { messages: Array<{ content: unknown[] }> };

		expect(result).not.toBe(payload);
		expect(result.messages).toHaveLength(0);
	});

	it("synthesizes a missing result and drops an orphan result", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "ls", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "bad" }] },
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu-1",
				content: "Tool output unavailable (interrupted before result)",
				is_error: true,
			},
		]);
	});

	it("repairs the kimi-to-opus bash_14 regression", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Running both tools." },
						{ type: "tool_use", id: "mcp_aside_repl_13", name: "mcp_aside_repl", input: {} },
						{ type: "tool_use", id: "bash_14", name: "bash", input: { command: "ls" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "mcp_aside_repl_13", content: "opened" },
						{ type: "text", text: "Follow-up context" },
					],
				},
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};

		expect(result.messages[1]?.content).toEqual([
			{ type: "tool_result", tool_use_id: "mcp_aside_repl_13", content: "opened" },
			{
				type: "tool_result",
				tool_use_id: "bash_14",
				content: "Tool output unavailable (interrupted before result)",
				is_error: true,
			},
			{ type: "text", text: "Follow-up context" },
		]);
	});

	it("prepends a missing result to string user content", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "bash_14", name: "bash", input: {} }] },
				{ role: "user", content: "Continue from here" },
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ content: string | Array<Record<string, unknown>> }>;
		};

		expect(result.messages[1]?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "bash_14",
				content: "Tool output unavailable (interrupted before result)",
				is_error: true,
			},
			{ type: "text", text: "Continue from here" },
		]);
	});

	it("inserts a missing result when the payload ends after tool_use", () => {
		const payload = {
			messages: [
				{ role: "user", content: "Run it" },
				{ role: "assistant", content: [{ type: "tool_use", id: "bash_14", name: "bash", input: {} }] },
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
		};

		expect(result.messages).toHaveLength(3);
		expect(result.messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "bash_14",
					content: "Tool output unavailable (interrupted before result)",
					is_error: true,
				},
			],
		});
	});

	it("keeps one immediate result and drops duplicate or misplaced copies", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "ls", input: {} }] },
				{
					role: "user",
					content: [
						{ type: "text", text: "after result" },
						{ type: "tool_result", tool_use_id: "toolu-1", content: "first" },
						{ type: "tool_result", tool_use_id: "toolu-1", content: "duplicate" },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "late" }] },
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]?.content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu-1", content: "first" },
			{ type: "text", text: "after result" },
		]);
	});

	it("keeps paired tool_result and removes orphan from same user message", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "ls", input: {} }] },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
						{ type: "tool_result", tool_use_id: "toolu-2", content: "orphan" },
					],
				},
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]?.content).toEqual([{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" }]);
	});

	it("strips multiple consecutive orphan messages", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "ls", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "bad-1", content: "a" }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "bad-2", content: "b" }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" }] },
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]?.role).toBe("user");
		expect(result.messages[1]?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu-1",
				content: "Tool output unavailable (interrupted before result)",
				is_error: true,
			},
		]);
	});

	it("drops tool_result blocks with missing or empty tool_use_id", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "ls", input: {} }] },
				{
					role: "user",
					content: [
						{ type: "tool_result", content: "missing" },
						{ type: "tool_result", tool_use_id: "", content: "empty" },
						{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
					],
				},
			],
		};

		const result = sanitizeAnthropicPayload(payload) as {
			messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>;
		};

		expect(result.messages[1]?.content).toEqual([{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" }]);
	});

	it("returns a new payload and does not mutate input when modified", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "ls", input: {} }] },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
						{ type: "tool_result", tool_use_id: "orphan", content: "drop" },
					],
				},
			],
		};

		const before = JSON.parse(JSON.stringify(payload)) as typeof payload;
		const result = sanitizeAnthropicPayload(payload) as typeof payload;

		expect(result).not.toBe(payload);
		expect(payload).toEqual(before);
	});
});
