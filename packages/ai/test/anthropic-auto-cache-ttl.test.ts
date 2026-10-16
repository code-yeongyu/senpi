import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#3280: when a turn can outlive the 5-minute default prompt-cache TTL (max/high reasoning
// effort, or a long expected output), the stable prefix's cache_control carries ttl: "1h"
// automatically. Short turns keep the ephemeral default with no explicit ttl.

const mockState = vi.hoisted(() => ({
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		private readonly create = (params: Record<string, unknown>) => {
			mockState.createParams = params;
			return { asResponse: async () => createSseResponse() };
		};
		beta = { messages: { create: this.create } };
		messages = { create: this.create };
	}

	return { default: FakeAnthropic };
});

// The mock owns the SDK, so the first-party base URL never reaches the network; it is required
// because the 1h TTL is gated on isAnthropicApiBaseUrl (senpi#3280).
function firstPartyModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "",
		name: "Opus",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	};
}

type CacheControlBlock = { type: string; ttl?: string };

function allCacheControls(params: Record<string, unknown>): CacheControlBlock[] {
	const controls: CacheControlBlock[] = [];
	const system = params.system;
	if (Array.isArray(system)) {
		for (const block of system as Array<{ cache_control?: CacheControlBlock }>) {
			if (block.cache_control) controls.push(block.cache_control);
		}
	}
	const messages = params.messages;
	if (Array.isArray(messages)) {
		for (const message of messages as Array<{ content?: unknown }>) {
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content as Array<{ cache_control?: CacheControlBlock }>) {
				if (block.cache_control) controls.push(block.cache_control);
			}
		}
	}
	const tools = params.tools;
	if (Array.isArray(tools)) {
		for (const tool of tools as Array<{ cache_control?: CacheControlBlock }>) {
			if (tool.cache_control) controls.push(tool.cache_control);
		}
	}
	return controls;
}

describe("automatic 1h prompt-cache TTL for long turns (senpi#3280)", () => {
	const context: Context = {
		systemPrompt: "You are concise.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	beforeEach(() => {
		mockState.createParams = undefined;
	});

	it("a max-reasoning turn marks the stable prefix with ttl 1h", async () => {
		const stream = streamAnthropic(firstPartyModel(), normalizeContext(context), {
			apiKey: "fake-key",
			effort: "xhigh",
			thinkingEnabled: true,
		});
		await stream.result();

		const controls = allCacheControls(mockState.createParams ?? {});
		expect(controls.length).toBeGreaterThan(0);
		expect(controls.some((cc) => cc.ttl === "1h")).toBe(true);
	});

	it("a short turn keeps the ephemeral default with no explicit ttl", async () => {
		const stream = streamAnthropic(firstPartyModel(), normalizeContext(context), {
			apiKey: "fake-key",
		});
		await stream.result();

		const controls = allCacheControls(mockState.createParams ?? {});
		expect(controls.length).toBeGreaterThan(0);
		expect(controls.every((cc) => cc.ttl === undefined)).toBe(true);
	});

	it("a long expected output (maxTokens >= 16384) marks the stable prefix with ttl 1h", async () => {
		const stream = streamAnthropic(firstPartyModel(), normalizeContext(context), {
			apiKey: "fake-key",
			maxTokens: 32768,
		});
		await stream.result();

		const controls = allCacheControls(mockState.createParams ?? {});
		expect(controls.length).toBeGreaterThan(0);
		expect(controls.some((cc) => cc.ttl === "1h")).toBe(true);
	});

	it("an explicit cacheRetention choice always wins over the automatic tier", async () => {
		const stream = streamAnthropic(firstPartyModel(), normalizeContext(context), {
			apiKey: "fake-key",
			maxTokens: 32768,
			cacheRetention: "short",
		});
		await stream.result();

		const controls = allCacheControls(mockState.createParams ?? {});
		expect(controls.length).toBeGreaterThan(0);
		expect(controls.every((cc) => cc.ttl === undefined)).toBe(true);
	});

	it("a non-first-party base URL never gets the 1h TTL even for a long turn", async () => {
		const stream = streamAnthropic(
			firstPartyModel({ baseUrl: "https://gateway.example.com/anthropic" }),
			normalizeContext(context),
			{ apiKey: "fake-key", maxTokens: 32768 },
		);
		await stream.result();

		const controls = allCacheControls(mockState.createParams ?? {});
		expect(controls.every((cc) => cc.ttl === undefined)).toBe(true);
	});
});
