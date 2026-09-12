import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { demoteToolUseWithoutToolCalls, EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC } from "../src/assistant-terminal-state.ts";
import { withEmptyAssistantRecovery } from "../src/empty-assistant-recovery.ts";

function nativeToolCallingModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5-1",
		name: "claude-fable-5-1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

function assistantMessage(
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function streamOf(message: AssistantMessage, reason: "stop" | "length" | "toolUse" = "toolUse") {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "done", reason, message });
		stream.end();
	});
	return stream;
}

const thinkingOnlyToolUse = (): AssistantMessage =>
	assistantMessage("toolUse", [{ type: "thinking", thinking: "planning", thinkingSignature: "sig" }]);

describe("empty tool_use recovery on native tool-calling providers", () => {
	it("retries the same request when tool_use arrives with no tool call", async () => {
		//#given - a native tool-calling model whose first response is toolUse with no tool call
		const model = nativeToolCallingModel();
		const seen: Array<{ model: Model<never> | undefined; context: Context | undefined }> = [];
		let call = 0;
		const streamFunction = (
			requestedModel: Model<never>,
			context: Context,
			_options?: SimpleStreamOptions,
		): ReturnType<typeof streamOf> => {
			seen.push({ model: requestedModel, context });
			call += 1;
			return call === 1
				? streamOf(thinkingOnlyToolUse())
				: streamOf(assistantMessage("toolUse", [{ type: "toolCall", id: "call-1", name: "eval", arguments: {} }]));
		};
		const context: Context = { systemPrompt: "", messages: [], tools: [] };

		//#when
		const recovered = withEmptyAssistantRecovery(model, streamFunction as never);
		const stream = await recovered(model as never, context, undefined);
		const message = await stream.result();

		//#then - the retry reissued the same request and the recovered tool call survived
		expect(seen).toHaveLength(2);
		expect(seen[1]?.model).toBe(model);
		expect(seen[1]?.context).toBe(context);
		expect(
			message.content.filter((block: AssistantMessage["content"][number]) => block.type === "toolCall"),
		).toHaveLength(1);
		expect(message.stopReason).toBe("toolUse");
	});

	it("leaves an unwrapped native model to the loop's demotion instead of a stream retry", async () => {
		//#given - a native tool-calling model that neither text-tool-call recovery nor a tool-call format covers
		const model: Model<"anthropic-messages"> = {
			...nativeToolCallingModel(),
			id: "gemini-3-pro",
			name: "gemini-3-pro",
		};
		let calls = 0;
		const streamFunction = (): ReturnType<typeof streamOf> => {
			calls += 1;
			return streamOf(thinkingOnlyToolUse());
		};
		const context: Context = { systemPrompt: "", messages: [], tools: [] };

		//#when
		const recovered = withEmptyAssistantRecovery(model, streamFunction as never);
		const message = await (await recovered(model as never, context, undefined)).result();

		//#then - the stream is not rewrapped, so liveness is preserved and no retry fires
		expect(calls).toBe(1);
		expect(recovered).toBe(streamFunction);

		//#then - the loop's demotion still removes the contradiction and records why
		const demoted = demoteToolUseWithoutToolCalls(message);
		expect(demoted.stopReason).toBe("stop");
		expect(
			demoted.diagnostics?.some(
				(entry: NonNullable<AssistantMessage["diagnostics"]>[number]) =>
					entry.type === EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC,
			),
		).toBe(true);
	});

	it("fails the turn as an error when the retry is malformed too", async () => {
		//#given - a native model that returns the malformed shape twice
		const model = nativeToolCallingModel();
		let call = 0;
		const streamFunction = (): ReturnType<typeof streamOf> => {
			call += 1;
			return streamOf(thinkingOnlyToolUse());
		};
		const context: Context = { systemPrompt: "", messages: [], tools: [] };

		//#when
		const recovered = withEmptyAssistantRecovery(model, streamFunction as never);
		const stream = await recovered(model as never, context, undefined);
		const message = await stream.result();

		//#then - the second malformed response is terminal rather than a silent clean end
		expect(call).toBe(2);
		expect(message.stopReason).toBe("error");
		expect(
			message.diagnostics?.some(
				(entry: NonNullable<AssistantMessage["diagnostics"]>[number]) =>
					entry.type === "empty_tool_use_response_recovery",
			),
		).toBe(true);
	});
});
