import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type AssistantMessage, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

/**
 * senpi#4608: a provider that accepted the request and keeps the connection alive (SSE `ping` events, or `:` comment
 * keep-alives a relay sends while the upstream model is still thinking) is working, not stuck. The silence bounds must
 * count those bytes, so a first token that arrives later than the bound is not killed; a connection that sends nothing
 * is still cut at the bound, and keep-alives alone are bounded by their own budget.
 */

const SILENCE_BOUND_MS = 2000;
const KEEP_ALIVE_EVERY_MS = 100;
const WARM_UP_BOUND_MS = 120_000;
const FIRST_TOKEN_AFTER_MS = SILENCE_BOUND_MS * 3;

type KeepAlive = "ping-event" | "comment";

const KEEP_ALIVE_FRAMES: Record<KeepAlive, string> = {
	"ping-event": 'event: ping\ndata: {"type":"ping"}\n\n',
	comment: ": ka\n\n",
};

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ANSWER_HEAD_FRAMES = [
	sse("message_start", {
		type: "message_start",
		message: {
			id: "msg_slow_first_token",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	}),
	sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "slow " },
	}),
].join("");

const ANSWER_TAIL_FRAMES = [
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "answer" },
	}),
	sse("content_block_stop", { type: "content_block_stop", index: 0 }),
	sse("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 2 },
	}),
	sse("message_stop", { type: "message_stop" }),
].join("");

type Behavior =
	| { kind: "answer-now" }
	| { kind: "keep-alive-then-answer"; keepAlive: KeepAlive }
	| { kind: "answer-paused-by-keep-alives" }
	| { kind: "keep-alive-forever" }
	| { kind: "silent" };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startProvider(behavior: Behavior): Promise<string> {
	const timers = new Set<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
	const responses = new Set<ServerResponse>();
	const server = createServer((request, response) => {
		request.resume();
		responses.add(response);
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.flushHeaders();
		if (behavior.kind === "silent") return;
		if (behavior.kind === "answer-now") {
			response.end(ANSWER_HEAD_FRAMES + ANSWER_TAIL_FRAMES);
			return;
		}
		if (behavior.kind === "answer-paused-by-keep-alives") response.write(ANSWER_HEAD_FRAMES);
		const frame = KEEP_ALIVE_FRAMES[behavior.kind === "keep-alive-then-answer" ? behavior.keepAlive : "ping-event"];
		const keepAlive = setInterval(() => response.write(frame), KEEP_ALIVE_EVERY_MS);
		timers.add(keepAlive);
		if (behavior.kind === "keep-alive-forever") return;
		const answer = setTimeout(() => {
			clearInterval(keepAlive);
			response.end(
				behavior.kind === "answer-paused-by-keep-alives"
					? ANSWER_TAIL_FRAMES
					: ANSWER_HEAD_FRAMES + ANSWER_TAIL_FRAMES,
			);
		}, FIRST_TOKEN_AFTER_MS);
		timers.add(answer);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(async () => {
		for (const timer of timers) clearTimeout(timer);
		for (const response of responses) response.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1024,
	};
}

function createConfig(baseUrl: string, overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model: createModel(baseUrl),
		apiKey: "test-key",
		cacheRetention: "none",
		convertToLlm: (messages: AgentMessage[]) => messages as unknown as Message[],
		streamStartTimeoutMs: SILENCE_BOUND_MS,
		timeoutMs: SILENCE_BOUND_MS,
		maxRetries: 0,
		...overrides,
	};
}

function createContext(): AgentContext {
	return { systemPrompt: "You are helpful.", messages: [], tools: [] };
}

async function runTurn(config: AgentLoopConfig): Promise<AssistantMessage> {
	const stream = agentLoop(
		[{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() }],
		createContext(),
		config,
		undefined,
		streamSimple,
	);
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	const assistant = (await stream.result()).find(
		(message): message is AssistantMessage => message.role === "assistant",
	);
	if (assistant === undefined) throw new Error(`no assistant message; events: ${events.map((e) => e.type).join(",")}`);
	return assistant;
}

describe("agent loop: transport keep-alives before the first token (senpi#4608)", () => {
	beforeAll(async () => {
		const warm = await runTurn(
			createConfig(await startProvider({ kind: "answer-now" }), {
				streamStartTimeoutMs: 0,
				timeoutMs: WARM_UP_BOUND_MS,
			}),
		);
		expect(warm.errorMessage).toBeUndefined();
		expect(warm.stopReason).toBe("stop");
	}, WARM_UP_BOUND_MS);

	it.each<KeepAlive>(["ping-event", "comment"])(
		"does not kill a request whose first token arrives after the silence bound while %s keep-alives flow",
		async (keepAlive) => {
			const baseUrl = await startProvider({ kind: "keep-alive-then-answer", keepAlive });

			const assistant = await runTurn(createConfig(baseUrl));

			expect(assistant.errorMessage).toBeUndefined();
			expect(assistant.stopReason).toBe("stop");
			expect(assistant.content).toEqual([{ type: "text", text: "slow answer" }]);
		},
	);

	it("does not kill a stream that pauses mid-answer for longer than the idle bound while keep-alives flow", async () => {
		const baseUrl = await startProvider({ kind: "answer-paused-by-keep-alives" });

		const assistant = await runTurn(createConfig(baseUrl));

		expect(assistant.errorMessage).toBeUndefined();
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.content).toEqual([{ type: "text", text: "slow answer" }]);
	});

	it("still cuts an accepted request that sends no bytes at all at the silence bound", async () => {
		const baseUrl = await startProvider({ kind: "silent" });

		const assistant = await runTurn(createConfig(baseUrl));

		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toBe(
			`Provider stream start timed out after ${SILENCE_BOUND_MS}ms (raise streamStartTimeoutMs: retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)`,
		);
	});

	it("ends a request that only ever sends keep-alives once the keep-alive budget is spent", async () => {
		const baseUrl = await startProvider({ kind: "keep-alive-forever" });
		const keepAliveBudgetMs = SILENCE_BOUND_MS * 2;

		const assistant = await runTurn(createConfig(baseUrl, { streamKeepAliveTimeoutMs: keepAliveBudgetMs }));

		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toBe(
			`Provider stream sent only keep-alives and timed out after ${keepAliveBudgetMs}ms (raise streamKeepAliveTimeoutMs: retry.provider.keepAliveTimeoutMs in senpi settings; 0 disables)`,
		);
	});
});
