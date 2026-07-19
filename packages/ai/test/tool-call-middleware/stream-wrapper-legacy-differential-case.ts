import { expect, it } from "vitest";
import { getProtocol } from "../../src/tool-call-middleware/context-transformer.ts";
import { wrapStreamWithToolCallMiddleware } from "../../src/tool-call-middleware/stream-wrapper.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { weatherTool } from "./stream-wrapper-fixtures.ts";

const legacyUsage: AssistantMessage["usage"] = {
	input: 10,
	output: 5,
	cacheRead: 3,
	cacheWrite: 2,
	totalTokens: 20,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 },
};

function sourceMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "legacy-model",
		responseModel: "routed-model",
		responseId: "response-legacy",
		diagnostics: [{ type: "source_diagnostic", timestamp: 7 }],
		content,
		usage: { ...legacyUsage, cacheWrite1h: 1, reasoning: 4, cost: { ...legacyUsage.cost } },
		stopReason: "stop",
		timestamp: 909,
		fixtureMetadata: { retainedByRecoveryOnly: true },
	} as AssistantMessage;
}

function parentMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "legacy-model",
		responseId: "response-legacy",
		content,
		usage: { ...legacyUsage, cost: { ...legacyUsage.cost } },
		stopReason: "stop",
		errorMessage: undefined,
		timestamp: 909,
	};
}

async function collectSnapshots(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(structuredClone(event));
	return events;
}

export function registerLegacyProjectionDifferentialCase(): void {
	it("keeps the legacy text-protocol wrapper byte-identical to its parent projection", async () => {
		const inner = new AssistantMessageEventStream();
		const partial = sourceMessage([]);
		const wrapped = wrapStreamWithToolCallMiddleware(inner, getProtocol("hermes"), [weatherTool]);
		inner.push({ type: "start", partial: structuredClone(partial) });
		partial.content.push({ type: "thinking", thinking: "", thinkingSignature: "thinking-signature" });
		inner.push({ type: "thinking_start", contentIndex: 0, partial: structuredClone(partial) });
		partial.content[0] = {
			type: "thinking",
			thinking: "signed thought",
			thinkingSignature: "thinking-signature",
		};
		inner.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "signed thought",
			partial: structuredClone(partial),
		});
		inner.push({
			type: "thinking_end",
			contentIndex: 0,
			content: "signed thought",
			partial: structuredClone(partial),
		});
		partial.content.push({
			type: "thinking",
			thinking: "[Reasoning redacted]",
			thinkingSignature: "redacted-payload",
			redacted: true,
		});
		inner.push({ type: "thinking_start", contentIndex: 1, partial: structuredClone(partial) });
		inner.push({
			type: "thinking_end",
			contentIndex: 1,
			content: "[Reasoning redacted]",
			partial: structuredClone(partial),
		});
		partial.content.push({ type: "text", text: "", textSignature: "text-signature" });
		inner.push({ type: "text_start", contentIndex: 2, partial: structuredClone(partial) });
		partial.content[2] = { type: "text", text: "signed text", textSignature: "text-signature" };
		inner.push({ type: "text_delta", contentIndex: 2, delta: "signed text", partial: structuredClone(partial) });
		inner.push({ type: "text_end", contentIndex: 2, content: "signed text", partial: structuredClone(partial) });
		inner.push({ type: "done", reason: "stop", message: structuredClone(partial) });

		const events = await collectSnapshots(wrapped);
		const result = await wrapped.result();
		const thought = { type: "thinking" as const, thinking: "signed thought" };
		const redacted = { type: "thinking" as const, thinking: "[Reasoning redacted]" };
		const text = { type: "text" as const, text: "signed text" };
		expect(events).toStrictEqual([
			{ type: "start", partial: parentMessage([]) },
			{ type: "thinking_start", contentIndex: 0, partial: parentMessage([{ type: "thinking", thinking: "" }]) },
			{ type: "thinking_delta", contentIndex: 0, delta: "signed thought", partial: parentMessage([thought]) },
			{ type: "thinking_end", contentIndex: 0, content: "signed thought", partial: parentMessage([thought]) },
			{
				type: "thinking_start",
				contentIndex: 1,
				partial: parentMessage([thought, { type: "thinking", thinking: "" }]),
			},
			{
				type: "thinking_end",
				contentIndex: 1,
				content: "[Reasoning redacted]",
				partial: parentMessage([thought, redacted]),
			},
			{ type: "text_start", contentIndex: 2, partial: parentMessage([thought, redacted]) },
			{
				type: "text_delta",
				contentIndex: 2,
				delta: "signed text",
				partial: parentMessage([thought, redacted, text]),
			},
			{
				type: "text_end",
				contentIndex: 2,
				content: "signed text",
				partial: parentMessage([thought, redacted, text]),
			},
			{ type: "done", reason: "stop", message: parentMessage([thought, redacted, text]) },
		]);
		expect(result).toStrictEqual(parentMessage([thought, redacted, text]));
	});
}
