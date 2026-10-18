import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeChatGptSubscriptionWebSocketSessions,
	streamSimple as streamCodex,
} from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Context, SimpleStreamOptions } from "../src/types.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;

afterEach(() => {
	closeChatGptSubscriptionWebSocketSessions();
	vi.unstubAllGlobals();
});

function completion(serviceTier: string, inputTokens = 100_000): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				service_tier: serviceTier,
				output: [],
				usage: {
					input_tokens: inputTokens,
					output_tokens: 1000,
					total_tokens: inputTokens + 1000,
					input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 1000 },
				},
			},
		})}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe.each(["openai", "chatgpt-subscription"] as const)("%s Ultrafast", (provider) => {
	function run(options: SimpleStreamOptions) {
		return provider === "openai"
			? streamResponses(getModel("openai", "gpt-6-astra"), context, options).result()
			: streamCodex(getModel("chatgpt-subscription", "gpt-6-astra"), context, options).result();
	}

	it.each(EFFORTS)("preserves %s effort alongside ultrafast on the simple request path", async (effort) => {
		let payload: unknown;
		const result = await run({
			apiKey: token,
			transport: "sse",
			serviceTier: "ultrafast",
			reasoning: effort,
			fetch: async () => completion("ultrafast"),
			onPayload: (body) => {
				payload = body;
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(payload).toMatchObject({
			model: "gpt-6-astra",
			service_tier: "ultrafast",
			reasoning: { effort },
		});
	});

	it.each([100_000, 300_000])("prices all token classes at 6x Standard with %i input tokens", async (inputTokens) => {
		const result = await run({
			apiKey: token,
			transport: "sse",
			serviceTier: "ultrafast",
			reasoning: "xhigh",
			fetch: async () => completion(provider === "chatgpt-subscription" ? "default" : "ultrafast", inputTokens),
		});
		expect(result.stopReason).toBe("stop");
		const longContext = inputTokens > 272_000;
		const rates = longContext
			? { input: 120, output: 450, cacheRead: 12, cacheWrite: 150 }
			: { input: 60, output: 300, cacheRead: 6, cacheWrite: 75 };
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			expect(result.usage.cost[key]).toBeCloseTo((result.usage[key] * rates[key]) / 1_000_000, 8);
		}
		expect(result.usage.cost.total).toBeCloseTo(
			result.usage.cost.input +
				result.usage.cost.output +
				result.usage.cost.cacheRead +
				result.usage.cost.cacheWrite,
			8,
		);
	});
});

describe.each(["openai", "chatgpt-subscription"] as const)("%s Ultrafast price scope", (provider) => {
	it.each(
		(
			[
				{ id: "gpt-6.1-sol", upstreamModelId: "gpt-6.1-sol" },
				{ id: "gpt-6.1-sol-ultrafast", upstreamModelId: "gpt-6.1-sol" },
				{ id: "gpt-6-astra-ultrafast", upstreamModelId: "gpt-6-astra" },
			] as const
		).flatMap((model) => [100_000, 300_000].map((inputTokens) => ({ ...model, inputTokens }))),
	)("prices $id at 6x Standard with $inputTokens input tokens", async ({ id, upstreamModelId, inputTokens }) => {
		let payload: unknown;
		const options: SimpleStreamOptions = {
			apiKey: token,
			transport: "sse",
			serviceTier: "ultrafast",
			fetch: async () => completion(provider === "chatgpt-subscription" ? "default" : "ultrafast", inputTokens),
			onPayload: (body) => {
				payload = body;
			},
		};
		const result = await (provider === "openai"
			? streamResponses({ ...getModel("openai", upstreamModelId), id, upstreamModelId }, context, options)
			: streamCodex({ ...getModel("chatgpt-subscription", upstreamModelId), id, upstreamModelId }, context, options)
		).result();
		expect(result.stopReason).toBe("stop");
		// The session resolves wire aliases; these direct adapter calls isolate pricing metadata.
		expect(payload).toMatchObject({ model: id, service_tier: "ultrafast" });
		const longContext = inputTokens > 272_000;
		const rates =
			upstreamModelId === "gpt-6.1-sol"
				? longContext
					? { input: 24, output: 90, cacheRead: 1.2, cacheWrite: 30 }
					: { input: 12, output: 60, cacheRead: 0.6, cacheWrite: 15 }
				: longContext
					? { input: 120, output: 450, cacheRead: 12, cacheWrite: 150 }
					: { input: 60, output: 300, cacheRead: 6, cacheWrite: 75 };
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			expect(result.usage.cost[key]).toBeCloseTo((result.usage[key] * rates[key]) / 1_000_000, 8);
		}
		expect(result.usage.cost.total).toBeCloseTo(
			result.usage.cost.input +
				result.usage.cost.output +
				result.usage.cost.cacheRead +
				result.usage.cost.cacheWrite,
			8,
		);
	});

	it("keeps gpt-6-sol at its base rate when ultrafast is requested", async () => {
		const run = (serviceTier?: "ultrafast") => {
			const options = {
				apiKey: token,
				transport: "sse" as const,
				serviceTier,
				fetch: async () => completion(serviceTier ?? "default"),
			};
			return provider === "openai"
				? streamResponses(getModel("openai", "gpt-6-sol"), context, options).result()
				: streamCodex(getModel("chatgpt-subscription", "gpt-6-sol"), context, options).result();
		};
		const base = await run();
		const ultrafast = await run("ultrafast");
		expect(base.stopReason).toBe("stop");
		expect(ultrafast.stopReason).toBe("stop");
		expect(base.usage.cost.total).toBeGreaterThan(0);
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
			expect(ultrafast.usage.cost[key]).toBeCloseTo(base.usage.cost[key]);
		}
	});
});

describe("ChatGPT Subscription routing hint", () => {
	const astra = getModel("chatgpt-subscription", "gpt-6-astra");
	const cases = [
		[undefined, "model=gpt-6-astra"],
		["priority", "model=gpt-6-astra;tier=priority"],
		["ultrafast", "model=gpt-6-astra;tier=ultrafast"],
	] as const;

	it.each(cases)("sends the SSE request with tier %s as %s", async (serviceTier, hint) => {
		let headers: Headers | undefined;
		const result = await streamCodex(astra, context, {
			apiKey: token,
			transport: "sse",
			serviceTier,
			fetch: async (_input, init) => {
				headers = new Headers(init?.headers);
				return completion(serviceTier ?? "default");
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(headers?.get("x-codex-routing-hint")).toBe(hint);
	});

	it.each(cases)("opens the WebSocket with tier %s as %s", async (serviceTier, hint) => {
		const handshakes: Record<string, string>[] = [];
		class MockWebSocket extends EventTarget {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			constructor(_url: string, options: { headers: Record<string, string> }) {
				super();
				handshakes.push(
					Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value])),
				);
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send(): void {
				const response = {
					id: "resp_1",
					status: "completed",
					output: [],
					usage: { input_tokens: 1, output_tokens: 0 },
				};
				queueMicrotask(() =>
					this.dispatchEvent(
						Object.assign(new Event("message"), {
							data: JSON.stringify({ type: "response.completed", response }),
						}),
					),
				);
			}
			close(): void {
				this.readyState = 3;
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);
		const result = await streamCodex(astra, context, {
			apiKey: token,
			sessionId: `routing-hint-${serviceTier ?? "none"}`,
			transport: "websocket",
			serviceTier,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(handshakes.map((headers) => headers["x-codex-routing-hint"])).toEqual([hint]);
	});
});

describe("Ultrafast WebSocket continuations", () => {
	it.each(EFFORTS)("keeps %s effort and resets the chain when entering or leaving Ultrafast", async (effort) => {
		const handshakes: Array<string | null> = [];
		const bodies: Array<{
			input: unknown[];
			previous_response_id?: string;
			service_tier?: string;
			reasoning?: { effort: string };
		}> = [];
		class MockWebSocket extends EventTarget {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			constructor(_url: string, options: { headers: Record<string, string> }) {
				super();
				handshakes.push(new Headers(options.headers).get("x-codex-routing-hint"));
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send(data: string): void {
				bodies.push(JSON.parse(data));
				const response = {
					id: `resp_${bodies.length}`,
					status: "completed",
					output: [],
					usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
				};
				queueMicrotask(() =>
					this.dispatchEvent(
						Object.assign(new Event("message"), {
							data: JSON.stringify({ type: "response.completed", response }),
						}),
					),
				);
			}
			close(): void {
				this.readyState = 3;
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Unexpected HTTP fallback");
			}),
		);
		const transcript: Context = { messages: [] };
		for (const serviceTier of [undefined, "ultrafast", "ultrafast", undefined] as const) {
			transcript.messages.push({ role: "user", content: `Turn ${bodies.length + 1}`, timestamp: bodies.length });
			const result = await streamCodex(
				getModel("chatgpt-subscription", "gpt-6-astra"),
				normalizeContext(transcript),
				{
					apiKey: token,
					sessionId: `ultrafast-${effort}`,
					transport: "websocket-cached",
					serviceTier,
					reasoning: effort,
				},
			).result();
			expect(result.stopReason).toBe("stop");
		}
		expect(handshakes).toEqual(["model=gpt-6-astra", "model=gpt-6-astra;tier=ultrafast", "model=gpt-6-astra"]);
		expect(bodies.map((body) => body.service_tier)).toEqual([undefined, "ultrafast", "ultrafast", undefined]);
		expect(bodies.map((body) => body.reasoning?.effort)).toEqual([effort, effort, effort, effort]);
		expect(bodies.map((body) => body.previous_response_id)).toEqual([undefined, undefined, "resp_2", undefined]);
		expect(bodies.map((body) => body.input.length)).toEqual([1, 2, 1, 4]);
	});
});
