import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const REAL_MALFORMED_THINKING =
	'vue install vtracer 2>&1 | tail -5; command -v vtracer; ls /opt/homebrew/bin | grep -iE \'vtrace|vtracer\'<|close|>argument<|sep|><|open|>argument key="description" type="string"<|sep|>Check vtracer brew formula availability<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|><|close|>message<|sep|>';

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	options: Pick<AssistantMessage, "errorMessage" | "stopDetails"> = {},
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
		...options,
	};
}

function model(id = "kimi-test", toolCallFormat?: "antml"): Model<"openai-completions"> {
	return {
		id,
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		...(toolCallFormat === undefined ? {} : { compat: { toolCallFormat } }),
	};
}

function streamMessage(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
	} else if (message.stopReason === "pending") {
		throw new Error("Test response must have a terminal stop reason");
	} else stream.push({ type: "done", reason: message.stopReason, message });
	return stream;
}

function streamContent(message: AssistantMessage) {
	if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") {
		throw new Error("Streamed content fixture requires a successful terminal stop reason");
	}
	const stopReason = message.stopReason;
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = { ...message, content: [] };
		stream.push({ type: "start", partial });
		for (const [contentIndex, block] of message.content.entries()) {
			if (block.type === "text") {
				partial.content = [...partial.content, { type: "text", text: "" }];
				stream.push({ type: "text_start", contentIndex, partial });
				partial.content[contentIndex] = block;
				stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial });
			} else if (block.type === "thinking") {
				partial.content = [...partial.content, { type: "thinking", thinking: "" }];
				stream.push({ type: "thinking_start", contentIndex, partial });
				partial.content[contentIndex] = block;
				stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
			}
		}
		stream.push({ type: "done", reason: stopReason, message });
	});
	return stream;
}

function visibleText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function isLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function assistantStreamEvents(events: AgentEvent[]): AssistantMessageEvent[] {
	return events.flatMap((event) => (event.type === "message_update" ? [event.assistantMessageEvent] : []));
}

async function collectBounded(stream: ReturnType<typeof agentLoop>) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const events: AgentEvent[] = [];
				for await (const event of stream) events.push(event);
				return { events, messages: await stream.result() };
			})(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("empty assistant recovery probe did not finish")), 500);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function config(modelId = "kimi-test", toolCallFormat?: "antml"): AgentLoopConfig {
	return { model: model(modelId, toolCallFormat), convertToLlm: (messages) => messages.filter(isLlmMessage) };
}

describe("agent loop empty assistant recovery", () => {
	it("discards and retries the real zero-width Kimi fixture without forwarding attempt-one events", async () => {
		const malformed = assistant([
			{ type: "text", text: "\u200b" },
			{ type: "thinking", thinking: REAL_MALFORMED_THINKING },
		]);
		const recovered = assistant([{ type: "text", text: "Recovered after retry" }]);
		const responses = [malformed, recovered];
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "answer", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [] },
			config(),
			undefined,
			() => streamContent(responses[streamCalls++] ?? recovered),
		);
		const { events, messages } = await collectBounded(stream);
		const assistants = messages.filter((message) => message.role === "assistant");
		const streamed = assistantStreamEvents(events);

		expect(streamCalls).toBe(2);
		expect(assistants).toHaveLength(1);
		expect(visibleText(assistants[0])).toBe("Recovered after retry");
		expect(assistants[0].diagnostics).toContainEqual({
			type: "empty_assistant_response_recovery",
			timestamp: expect.any(Number),
			details: { retries: 1 },
		});
		expect(streamed.some((event) => event.type === "thinking_delta" && event.delta === REAL_MALFORMED_THINKING)).toBe(
			false,
		);
		expect(streamed.some((event) => event.type === "text_delta" && event.delta === "\u200b")).toBe(false);
		expect(
			streamed.filter((event) => event.type === "text_delta" && event.delta === "Recovered after retry"),
		).toHaveLength(1);
	});

	it.each([
		["claude-sonnet-test", undefined],
		["generic-model-test", "antml"],
	] as const)("retries an invisible stop for text-protocol model %s", async (modelId, toolCallFormat) => {
		const empty = assistant([{ type: "thinking", thinking: "No visible answer." }]);
		const recovered = assistant([{ type: "text", text: `Recovered ${modelId}` }]);
		const responses = [empty, recovered];
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "answer", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [] },
			config(modelId, toolCallFormat),
			undefined,
			() => streamMessage(responses[streamCalls++] ?? recovered),
		);
		const { messages } = await collectBounded(stream);
		const assistants = messages.filter((message) => message.role === "assistant");

		expect(streamCalls).toBe(2);
		expect(assistants).toHaveLength(1);
		expect(visibleText(assistants[0])).toBe(`Recovered ${modelId}`);
	});

	it("leaves a plain generic thinking-only stream unbuffered for downstream observers", async () => {
		const thinkingOnly = assistant([{ type: "thinking", thinking: "Observable downstream reasoning." }]);
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "answer", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [] },
			config("generic-model-test"),
			undefined,
			() => {
				streamCalls += 1;
				return streamContent(thinkingOnly);
			},
		);
		const { events, messages } = await collectBounded(stream);

		expect(streamCalls).toBe(1);
		expect(messages.filter((message) => message.role === "assistant")).toEqual([thinkingOnly]);
		expect(
			assistantStreamEvents(events).some(
				(event) => event.type === "thinking_delta" && event.delta === "Observable downstream reasoning.",
			),
		).toBe(true);
	});

	it("turns a second invisible stop into a visible bounded failure", async () => {
		const empty = assistant([
			{ type: "text", text: "\u2060" },
			{ type: "thinking", thinking: "Still empty." },
		]);
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "answer", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [] },
			config(),
			undefined,
			() => {
				streamCalls += 1;
				return streamMessage(empty);
			},
		);
		const { messages } = await collectBounded(stream);
		const assistants = messages.filter((message) => message.role === "assistant");

		expect(streamCalls).toBe(2);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]).toMatchObject({
			stopReason: "error",
			errorMessage: "Model returned an empty response twice",
		});
		expect(visibleText(assistants[0])).toBe("Model returned an empty response twice");
	});

	it("passes a normal visible response through unchanged with one set of streamed events", async () => {
		const visible = assistant([{ type: "text", text: "Ordinary response" }]);
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "answer", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [] },
			config("generic-model-test"),
			undefined,
			() => {
				streamCalls += 1;
				return streamContent(visible);
			},
		);
		const { events, messages } = await collectBounded(stream);
		const assistants = messages.filter((message) => message.role === "assistant");
		const streamed = assistantStreamEvents(events);

		expect(streamCalls).toBe(1);
		expect(assistants).toEqual([visible]);
		expect(
			streamed.filter((event) => event.type === "text_delta" && event.delta === "Ordinary response"),
		).toHaveLength(1);
	});

	it("does not retry terminal errors, aborts, refusals, or length stops", async () => {
		for (const message of [
			assistant([], "error", { errorMessage: "transport failed" }),
			assistant([], "aborted", { errorMessage: "Request was aborted" }),
			assistant([], "error", { errorMessage: "classified", stopDetails: { type: "refusal" } }),
			assistant([{ type: "thinking", thinking: "truncated" }], "length"),
		]) {
			let streamCalls = 0;
			const stream = agentLoop(
				[{ role: "user", content: "answer", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [] },
				config(),
				undefined,
				() => {
					streamCalls += 1;
					return streamMessage(message);
				},
			);
			const { messages } = await collectBounded(stream);

			expect(streamCalls, message.stopReason).toBe(1);
			expect(messages.filter((item) => item.role === "assistant").at(-1), message.stopReason).toMatchObject({
				stopReason: message.stopReason,
			});
		}
	});

	it("preserves tool-call execution instead of treating it as empty", async () => {
		const schema = Type.Object({ value: Type.String() });
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "Echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			execute,
		};
		const responses = [
			assistant([{ type: "toolCall", id: "call-1", name: "Echo", arguments: { value: "ok" } }], "toolUse"),
			assistant([{ type: "text", text: "done" }]),
		];
		let streamCalls = 0;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const stream = agentLoop([{ role: "user", content: "echo", timestamp: 1 }], context, config(), undefined, () =>
			streamMessage(responses[streamCalls++] ?? responses[1]),
		);
		await collectBounded(stream);

		expect(streamCalls).toBe(2);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
