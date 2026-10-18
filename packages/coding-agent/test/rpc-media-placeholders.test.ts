import { describe, expect, it } from "vitest";
import { omitInlineMedia } from "../src/modes/rpc/media-placeholders.ts";

const PNG_BASE64 = "aGVsbG8gd29ybGQh"; // 16 chars, no padding -> 12 bytes

function toolResultMessage(data: string): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: "call_abc",
		toolName: "read",
		content: [
			{ type: "text", text: "read image" },
			{ type: "image", data, mimeType: "image/png" },
		],
	};
}

describe("omitInlineMedia", () => {
	it("returns the same reference when the record carries no tool-result image", () => {
		const record = {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		};

		expect(omitInlineMedia(record)).toBe(record);
	});

	it("never walks a message_update record even when it nests a toolResult image", () => {
		// The hot path must pay nothing: message_update is type-gated out, so a
		// (non-production) nested toolResult image is returned untouched, by reference.
		const record = {
			type: "message_update",
			message: toolResultMessage(PNG_BASE64),
		};

		expect(omitInlineMedia(record)).toBe(record);
	});

	it("replaces images inside a toolResult message and copies on write", () => {
		const message = toolResultMessage(PNG_BASE64);
		const content = message.content;
		const record = { type: "message_end", sessionId: "rpc-1", message };

		const result = omitInlineMedia(record) as {
			type: string;
			sessionId: string;
			message: { content: Array<Record<string, unknown>> };
		};

		expect(result).not.toBe(record);
		expect(result.type).toBe("message_end");
		expect(result.sessionId).toBe("rpc-1");
		expect(result.message).not.toBe(message);
		expect(result.message.content).not.toBe(content);
		expect(result.message.content[0]).toEqual({ type: "text", text: "read image" });
		expect(result.message.content[1]).toEqual({
			type: "image_ref",
			mimeType: "image/png",
			byteLength: 12,
			ref: { toolCallId: "call_abc", contentIndex: 1 },
		});
		// Input untouched: responses hand out live session state.
		expect(message.content).toBe(content);
		expect((content as Array<Record<string, unknown>>)[1]).toEqual({
			type: "image",
			data: PNG_BASE64,
			mimeType: "image/png",
		});
	});

	it("replaces images inside tool_execution_end.result.content", () => {
		const record = {
			type: "tool_execution_end",
			toolCallId: "call_xyz",
			toolName: "read",
			result: {
				output: "ok",
				content: [{ type: "image", data: PNG_BASE64, mimeType: "image/jpeg" }],
			},
		};

		const result = omitInlineMedia(record) as { result: { output: string; content: Array<unknown> } };

		expect(result).not.toBe(record);
		expect(result.result.output).toBe("ok");
		expect(result.result.content[0]).toEqual({
			type: "image_ref",
			mimeType: "image/jpeg",
			byteLength: 12,
			ref: { toolCallId: "call_xyz", contentIndex: 0 },
		});
	});

	it("leaves user-message images intact", () => {
		const record = {
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
			},
		};

		expect(omitInlineMedia(record)).toBe(record);
	});

	it("transforms nested get_tree entries in a response payload", () => {
		const record = {
			type: "response",
			command: "get_tree",
			success: true,
			data: {
				tree: {
					entry: { type: "message", id: "e1", message: { role: "assistant", content: [] } },
					children: [
						{
							entry: { type: "message", id: "e2", message: toolResultMessage(PNG_BASE64) },
							children: [],
						},
					],
				},
			},
		};

		const result = omitInlineMedia(record) as unknown as {
			data: { tree: { children: Array<{ entry: { message: { content: Array<Record<string, unknown>> } } }> } };
		};

		expect(result).not.toBe(record);
		expect(result.data.tree.children[0]!.entry.message.content[1]).toEqual({
			type: "image_ref",
			mimeType: "image/png",
			byteLength: 12,
			ref: { toolCallId: "call_abc", contentIndex: 1 },
		});
	});

	it("transforms get_entries response entries", () => {
		const record = {
			type: "response",
			command: "get_entries",
			success: true,
			data: {
				entries: [
					{ type: "message", id: "e1", message: toolResultMessage(PNG_BASE64) },
					{ type: "thinking_level_change", id: "e2", thinkingLevel: "off" },
				],
			},
		};

		const result = omitInlineMedia(record) as {
			data: { entries: Array<{ message?: { content: Array<Record<string, unknown>> } }> };
		};

		expect(result.data.entries[0]!.message!.content[1]).toMatchObject({ type: "image_ref" });
		expect(result.data.entries[1]).toEqual({ type: "thinking_level_change", id: "e2", thinkingLevel: "off" });
	});

	it("transforms open_session state.entries", () => {
		const record = {
			type: "response",
			command: "open_session",
			success: true,
			data: {
				sessionId: "rpc-1",
				state: {
					entries: [{ type: "message", id: "e1", message: toolResultMessage(PNG_BASE64) }],
				},
			},
		};

		const result = omitInlineMedia(record) as unknown as {
			data: { state: { entries: Array<{ message: { content: Array<Record<string, unknown>> } }> } };
		};

		expect(result.data.state.entries[0]!.message.content[1]).toMatchObject({ type: "image_ref" });
	});

	it("leaves an unrelated response command untouched", () => {
		const record = {
			type: "response",
			command: "get_commands",
			success: true,
			data: { messages: [toolResultMessage(PNG_BASE64)] },
		};

		expect(omitInlineMedia(record)).toBe(record);
	});

	it("computes byteLength from the base64 length without decoding", () => {
		const cases: Array<{ data: string; bytes: number }> = [
			{ data: "", bytes: 0 },
			{ data: "QQ==", bytes: 1 },
			{ data: "QUI=", bytes: 2 },
			{ data: "QUJD", bytes: 3 },
			{ data: "A".repeat(1024), bytes: 768 },
		];

		for (const { data, bytes } of cases) {
			const record = {
				type: "tool_execution_end",
				toolCallId: "call_1",
				result: { content: [{ type: "image", data, mimeType: "image/png" }] },
			};
			const result = omitInlineMedia(record) as unknown as { result: { content: Array<{ byteLength: number }> } };
			expect(result.result.content[0]!.byteLength).toBe(bytes);
		}
	});

	it("keeps sibling blocks and only rebuilds the changed message", () => {
		const untouched = { role: "assistant", content: [{ type: "text", text: "hi" }] };
		const record = {
			type: "turn_end",
			toolResults: [untouched, toolResultMessage(PNG_BASE64)],
		};

		const result = omitInlineMedia(record) as { toolResults: Array<Record<string, unknown>> };

		expect(result.toolResults[0]).toBe(untouched);
		expect((result.toolResults[1] as { content: Array<Record<string, unknown>> }).content[1]).toMatchObject({
			type: "image_ref",
		});
	});
});
