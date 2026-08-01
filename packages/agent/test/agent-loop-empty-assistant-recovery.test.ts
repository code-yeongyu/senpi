import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	options: Pick<AssistantMessage, "errorMessage" | "stopDetails"> = {},
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "kimi-test",
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

function model(): Model<"openai-completions"> {
	return {
		id: "kimi-test",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
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

function visibleText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function isLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
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

function config(): AgentLoopConfig {
	return { model: model(), convertToLlm: (messages) => messages.filter(isLlmMessage) };
}

describe("agent loop empty assistant recovery", () => {
	it("retries one thinking-only stop before committing the assistant turn", async () => {
		const responses = [
			assistant([{ type: "thinking", thinking: "No visible answer." }]),
			assistant([{ type: "text", text: "Recovered after retry" }]),
		];
		let streamCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "answer", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [] },
			config(),
			undefined,
			() => streamMessage(responses[streamCalls++] ?? responses[1]),
		);
		const { messages } = await collectBounded(stream);
		const assistants = messages.filter((message) => message.role === "assistant");

		expect(streamCalls).toBe(2);
		expect(assistants).toHaveLength(1);
		expect(visibleText(assistants[0])).toBe("Recovered after retry");
	});

	it("turns a second empty stop into a visible bounded failure", async () => {
		const empty = assistant([
			{ type: "text", text: "" },
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
