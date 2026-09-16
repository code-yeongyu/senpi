import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

/**
 * Regression coverage for the stream throughput watchdog (#1739).
 *
 * Every other guard on a live provider stream is a SILENCE detector: the
 * stream-start bound stops applying once the first event arrived and the
 * inter-event idle bound is re-armed by every event. A provider that keeps
 * answering at ~2 tok/s therefore looked perfectly healthy while the session
 * was unusable (reported for `gpt-6-astra`, September 2026). The watchdog
 * measures the RATE of streamed text/thinking units and aborts the in-flight
 * request with its own error when the sustained rate stays below the floor.
 */

class AssistantEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Emits `deltaCount` text deltas of `chunk`, one every `gapMs`, then finishes.
 * `chunk.length / 4` is the streamed-unit estimate the watchdog measures, so
 * the emitted rate is `(chunk.length / 4) / (gapMs / 1000)` units per second.
 */
class PacedTextStream extends AssistantEventStream {
	private readonly gapMs: number;
	private readonly deltaCount: number;
	private readonly chunk: string;
	private text = "";

	constructor(gapMs: number, deltaCount: number, chunk: string) {
		super();
		this.gapMs = gapMs;
		this.deltaCount = deltaCount;
		this.chunk = chunk;
	}

	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const partial = createAssistantMessage([{ type: "text", text: "" }]);
		yield { type: "start", partial };
		for (let index = 0; index < this.deltaCount; index++) {
			await new Promise((resolve) => setTimeout(resolve, this.gapMs));
			this.text += this.chunk;
			partial.content = [{ type: "text", text: this.text }];
			yield { type: "text_delta", contentIndex: 0, delta: this.chunk, partial };
		}
		yield { type: "done", reason: "stop", message: this.finalMessage() };
	}

	override result(): Promise<AssistantMessage> {
		return Promise.resolve(this.finalMessage());
	}

	private finalMessage(): AssistantMessage {
		return createAssistantMessage([{ type: "text", text: this.text }]);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

const identityConverter = (messages: AgentMessage[]): Message[] => messages as unknown as Message[];

function createContext(): AgentContext {
	return { systemPrompt: "You are helpful.", messages: [], tools: [] };
}

function findAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	return messages.find((message): message is AssistantMessage => message.role === "assistant");
}

async function runPacedLoop(
	config: AgentLoopConfig,
	makeStream: () => AssistantEventStream,
	advanceMs: number,
): Promise<{ assistant: AssistantMessage | undefined; requestSignal: AbortSignal | undefined }> {
	let requestSignal: AbortSignal | undefined;
	const stream = agentLoop([createUserMessage("Hello")], createContext(), config, undefined, (_m, _c, options) => {
		requestSignal = options?.signal;
		return makeStream();
	});
	const collected = (async () => {
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		return stream.result();
	})();
	await vi.advanceTimersByTimeAsync(advanceMs);
	const messages = await collected;
	return { assistant: findAssistant(messages), requestSignal };
}

describe("agent loop stream throughput watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts a stream that keeps trickling below the throughput floor", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 300_000,
			timeoutMs: 300_000,
		};

		// 2 tok/s: one 4-character delta every 500ms, for longer than the
		// 5s grace plus the 20s observation window.
		const { assistant, requestSignal } = await runPacedLoop(
			config,
			() => new PacedTextStream(500, 80, "word"),
			45_000,
		);

		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toMatch(/Provider stream throughput degraded: \d+(?:\.\d+)? tok\/s/);
		expect(assistant?.errorMessage).toContain("floor 8 tok/s");
		expect(assistant?.errorMessage).toContain("over 20s");
		expect(requestSignal?.aborted).toBe(true);
		expect(String(requestSignal?.reason)).toContain("Provider stream throughput degraded");
	});

	it("lets a healthy stream finish even when deltas are batched", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 300_000,
			timeoutMs: 300_000,
		};

		// 40 tok/s delivered as 5 units per delta every 125ms, over the same
		// observation window as the degraded case.
		const { assistant, requestSignal } = await runPacedLoop(
			config,
			() => new PacedTextStream(125, 240, "0123456789abcdefghij"),
			45_000,
		);

		expect(assistant?.stopReason).toBe("stop");
		expect(assistant?.errorMessage).toBeUndefined();
		// The loop always tears its own request controller down at the end of the
		// turn; that teardown must not carry a throughput verdict.
		expect(String(requestSignal?.reason ?? "")).not.toContain("Provider stream throughput degraded");
	});

	it("does not judge a stream that ends before the observation window closes", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 300_000,
			timeoutMs: 300_000,
		};

		// Same 2 tok/s trickle, but the answer completes after 20s of streaming
		// (5s grace + 15s of window): too early to judge, so it must finish.
		const { assistant } = await runPacedLoop(config, () => new PacedTextStream(500, 40, "word"), 45_000);

		expect(assistant?.stopReason).toBe("stop");
		expect(assistant?.errorMessage).toBeUndefined();
	});

	it("can be disabled with a zero floor", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 300_000,
			timeoutMs: 300_000,
			streamThroughput: { floorTokensPerSecond: 0 },
		};

		const { assistant } = await runPacedLoop(config, () => new PacedTextStream(500, 80, "word"), 60_000);

		expect(assistant?.stopReason).toBe("stop");
		expect(assistant?.errorMessage).toBeUndefined();
	});
});
