import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Api, AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "../src/types.ts";

function makeModel(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	} as Model<Api>;
}

function userMsg(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantWithCall(
	id: string,
	name: string,
	timestamp: number,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path: "." } }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function toolResult(id: string, name: string, timestamp: number, text = "ok"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

describe("transformMessages errored/aborted assistant tool results", () => {
	it("drops an errored assistant's toolCall and its real result", () => {
		const result = transformMessages(
			[
				userMsg("edit the file", 1),
				assistantWithCall("call-err", "edit", 2, "error"),
				toolResult("call-err", "edit", 3),
			],
			makeModel(),
		);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});

	it("drops an aborted assistant's toolCall and its downstream-synthesized placeholder result", () => {
		const result = transformMessages(
			[
				userMsg("edit the file", 1),
				assistantWithCall("call-aborted", "edit", 2, "aborted"),
				toolResult("call-aborted", "edit", 3, "Tool output unavailable (context compacted)"),
			],
			makeModel(),
		);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});

	it("preserves a kept assistant's toolCall and result", () => {
		const result = transformMessages(
			[userMsg("list files", 1), assistantWithCall("call-ok", "ls", 2), toolResult("call-ok", "ls", 3)],
			makeModel(),
		);
		expect(result).toHaveLength(3);
		expect(result[1].role).toBe("assistant");
		expect(result[2]).toMatchObject({ role: "toolResult", toolCallId: "call-ok" });
	});

	it("still synthesizes a 'No result provided' result for a kept assistant's unanswered call", () => {
		const result = transformMessages(
			[userMsg("list files", 1), assistantWithCall("call-open", "ls", 2)],
			makeModel(),
		);
		expect(result).toHaveLength(3);
		const synth = result[2] as ToolResultMessage;
		expect(synth.role).toBe("toolResult");
		expect(synth.toolCallId).toBe("call-open");
		expect(synth.isError).toBe(true);
		expect(synth.content).toEqual([{ type: "text", text: "No result provided" }]);
	});

	it("keeps a result whose id a later kept assistant re-declares", () => {
		const messages: Message[] = [
			userMsg("go", 1),
			assistantWithCall("call-reused", "edit", 2, "error"),
			toolResult("call-reused", "edit", 3, "stale"),
			assistantWithCall("call-reused", "edit", 4),
			toolResult("call-reused", "edit", 5, "fresh"),
		];
		const result = transformMessages(messages, makeModel());
		expect(result.map((m) => m.role)).toEqual(["user", "toolResult", "assistant", "toolResult"]);
		expect((result[2] as AssistantMessage).stopReason).toBe("toolUse");
		expect((result[3] as ToolResultMessage).content).toEqual([{ type: "text", text: "fresh" }]);
	});

	it("still emits true orphan results whose id no assistant declares", () => {
		const result = transformMessages([userMsg("hi", 1), toolResult("call-unknown", "ls", 2)], makeModel());
		expect(result).toHaveLength(2);
		expect(result[1]).toMatchObject({ role: "toolResult", toolCallId: "call-unknown" });
	});
});
