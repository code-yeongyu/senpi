import { describe, expect, it } from "vitest";
import { sanitizeAnthropicToolPairs } from "../src/api/anthropic-tool-pairs.ts";

interface ToolUseLike {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface ToolResultLike {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

function toolUse(id: string, name: string): ToolUseLike {
	return { type: "tool_use", id, name, input: {} };
}

function toolResult(id: string, content: string): ToolResultLike {
	return { type: "tool_result", tool_use_id: id, content };
}

function messagesOf(payload: unknown): Array<{ role: string; content: unknown }> {
	return (payload as { messages: Array<{ role: string; content: unknown }> }).messages;
}

function contentOf(message: { content: unknown }): Array<Record<string, unknown>> {
	return message.content as Array<Record<string, unknown>>;
}

// Cursor's exec channel can reuse one parent tool-call id for the sub-frames
// of a compound tool (StrReplace → read + write), so persisted transcripts can
// carry duplicate ids. Anthropic rejects the whole request with
// `tool_use ids must be unique`, permanently bricking session resume. The
// sanitizer is the final pre-submit pass and must repair the payload.
describe("sanitizeAnthropicToolPairs duplicate tool_use ids", () => {
	it("renames duplicate ids within one assistant message and remaps results in call order", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [toolUse("StrReplace_0_aa-1", "read"), toolUse("StrReplace_0_aa-1", "write")],
				},
				{
					role: "user",
					content: [
						toolResult("StrReplace_0_aa-1", "read output"),
						toolResult("StrReplace_0_aa-1", "write output"),
					],
				},
			],
		};

		const sanitized = sanitizeAnthropicToolPairs(payload);
		const [assistant, user] = messagesOf(sanitized);

		const useIds = contentOf(assistant).map((block) => block.id);
		expect(useIds).toHaveLength(2);
		expect(useIds[0]).toBe("StrReplace_0_aa-1");
		expect(useIds[1]).not.toBe("StrReplace_0_aa-1");
		expect(new Set(useIds).size).toBe(2);

		const results = contentOf(user).filter((block) => block.type === "tool_result");
		expect(results).toHaveLength(2);
		expect(results[0].tool_use_id).toBe(useIds[0]);
		expect(results[0].content).toBe("read output");
		expect(results[1].tool_use_id).toBe(useIds[1]);
		expect(results[1].content).toBe("write output");
	});

	it("renames ids duplicated across assistant messages", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: [toolUse("dup-1", "read")] },
				{ role: "user", content: [toolResult("dup-1", "first")] },
				{ role: "assistant", content: [toolUse("dup-1", "write")] },
				{ role: "user", content: [toolResult("dup-1", "second")] },
			],
		};

		const sanitized = sanitizeAnthropicToolPairs(payload);
		const [firstAssistant, firstUser, secondAssistant, secondUser] = messagesOf(sanitized);

		const firstId = contentOf(firstAssistant)[0].id as string;
		const secondId = contentOf(secondAssistant)[0].id as string;
		expect(firstId).toBe("dup-1");
		expect(secondId).not.toBe("dup-1");

		expect(contentOf(firstUser)[0].tool_use_id).toBe(firstId);
		expect(contentOf(secondUser)[0].tool_use_id).toBe(secondId);
	});

	it("synthesizes an error result for a renamed call whose result is missing", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [toolUse("solo-1", "read"), toolUse("solo-1", "write")],
				},
				{
					role: "user",
					content: [toolResult("solo-1", "only result")],
				},
			],
		};

		const sanitized = sanitizeAnthropicToolPairs(payload);
		const [assistant, user] = messagesOf(sanitized);
		const useIds = contentOf(assistant).map((block) => block.id as string);
		const results = contentOf(user).filter((block) => block.type === "tool_result");

		expect(new Set(useIds).size).toBe(2);
		expect(results).toHaveLength(2);
		expect(results.map((block) => block.tool_use_id).sort()).toEqual([...useIds].sort());
	});

	it("returns the payload unchanged when every id is already unique", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [toolUse("a-1", "read"), toolUse("b-2", "write")],
				},
				{
					role: "user",
					content: [toolResult("a-1", "one"), toolResult("b-2", "two")],
				},
			],
		};

		expect(sanitizeAnthropicToolPairs(payload)).toBe(payload);
	});
});
