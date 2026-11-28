import { afterEach, describe, expect, it } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { normalizeContext } from "../src/compat.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

// senpi#3399: with the default `display: "summarized"` thinking mode the summary
// streams as thinking_delta while the billed reasoning tokens sit in usage.output
// with no output_tokens_details.thinking_tokens count. The adapter knows the display
// mode from the request it sent, so it stamps usage.reasoningSummarized instead of
// leaving the timing layer to guess from stream content.

interface SentBody {
	model: string;
	thinking?: { type?: string; display?: string };
}

interface Sent {
	body: SentBody;
	raw: string;
}

type Responder = (sent: Sent) => Response;

let responseCount = 0;

function sse(events: unknown[]): Response {
	const body = events
		.map(
			(event) => `event: ${(event as { type: string }).type}
data: ${JSON.stringify(event)}

`,
		)
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A summarized-thinking reply: the summary streams, the usage carries no thinking count. */
function summarizedThinkingSse(): Response {
	responseCount++;
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${responseCount}`,
				model: "claude-opus-5-5",
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "condensed plan" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 1 },
		// No output_tokens_details: the thinking tokens are billed inside output_tokens only.
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 3_400 } },
		{ type: "message_stop" },
	];
	return sse(events);
}

function plainTextSse(): Response {
	responseCount++;
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${responseCount}`,
				model: "claude-opus-5-5",
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 4 } },
		{ type: "message_stop" },
	];
	return sse(events);
}

function gatewayClaude(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (gateway)",
		api: "anthropic-messages",
		provider: "custom-gateway",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });

async function run(
	options: { thinkingEnabled: boolean; thinkingDisplay?: "summarized" | "omitted" },
	respond: Responder,
): Promise<{ result: AssistantMessage; sent: Sent[] }> {
	const sent: Sent[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const raw = await request.text();
		const entry = { body: JSON.parse(raw) as SentBody, raw };
		sent.push(entry);
		return respond(entry);
	};
	const model = gatewayClaude();
	const result = await stream(model, normalizeContext({ messages: [user("hi", 1)] }), {
		apiKey: "test-key",
		cacheRetention: "none",
		maxRetries: 0,
		fetch: fetchImpl,
		...options,
	}).result();
	return { result, sent };
}

afterEach(() => cleanupSessionResources());

describe("summarized thinking usage marker (senpi#3399)", () => {
	it("stamps usage.reasoningSummarized when a summary streams without a reasoning count", async () => {
		const { result, sent } = await run({ thinkingEnabled: true }, () => summarizedThinkingSse());

		expect(sent[0]?.body.thinking?.display).toBe("summarized");
		expect(result.usage.reasoning).toBeUndefined();
		expect(result.usage.reasoningSummarized).toBe(true);
	});

	it("does not stamp the marker when the request asked for omitted display", async () => {
		const { result, sent } = await run({ thinkingEnabled: true, thinkingDisplay: "omitted" }, () =>
			summarizedThinkingSse(),
		);

		expect(sent[0]?.body.thinking?.display).toBe("omitted");
		expect(result.usage.reasoningSummarized).toBeUndefined();
	});

	it("does not stamp the marker on a plain streamed reply without thinking", async () => {
		const { result } = await run({ thinkingEnabled: true }, () => plainTextSse());

		expect(result.usage.reasoningSummarized).toBeUndefined();
	});
});
