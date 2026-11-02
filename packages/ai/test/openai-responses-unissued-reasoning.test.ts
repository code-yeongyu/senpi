import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#1836: a gateway rejects reasoning whose encrypted_content was issued to another caller. The rejection is
// verbatim from the report (OpenCode Go); the session must recover by dropping the replayed reasoning items.
const UNISSUED_REJECTION = {
	param: null,
	type: "invalid_request_error",
	message:
		"Upstream request failed: [invalid_request_error] reasoning encrypted_content was not issued to this caller",
};

const COMPLETED_SSE = `data: ${JSON.stringify({
	type: "response.completed",
	sequence_number: 0,
	response: {
		id: "resp_ok",
		status: "completed",
		usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
	},
})}\n\ndata: [DONE]\n\n`;

interface SentInput {
	readonly type?: string;
	readonly id?: string;
}

function reasoningIds(input: readonly SentInput[]): string[] {
	return input.filter((item) => item.type === "reasoning").map((item) => item.id ?? "");
}

function gateway(unissued: ReadonlySet<string>, sent: string[][], rejection = UNISSUED_REJECTION): typeof fetch {
	return async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("expected a JSON string request body");
		const ids = reasoningIds((JSON.parse(init.body) as { input: SentInput[] }).input);
		sent.push(ids);
		if (ids.some((id) => unissued.has(id))) {
			return new Response(JSON.stringify({ error: rejection }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

function priorTurn(model: Model<"openai-responses">, reasoningId: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "thinking",
				thinking: `reasoning ${reasoningId}`,
				thinkingSignature: JSON.stringify({
					id: reasoningId,
					type: "reasoning",
					summary: [],
					encrypted_content: `opaque-${reasoningId}`,
					status: "completed",
				}),
			},
			{ type: "text", text: `answer after ${reasoningId}` },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function contextWith(model: Model<"openai-responses">, reasoningIdsSoFar: readonly string[]): Message[] {
	return reasoningIdsSoFar.flatMap((id, index) => [
		{ role: "user" as const, content: `question ${index}`, timestamp: 1 },
		priorTurn(model, id),
	]);
}

async function runTurn(
	model: Model<"openai-responses">,
	history: Message[],
	fetchStub: typeof fetch,
	sessionId: string,
): Promise<AssistantMessage> {
	const events = streamOpenAIResponses(
		model,
		normalizeContext({
			systemPrompt: "sys",
			messages: [...history, { role: "user", content: "next", timestamp: 2 }],
		}),
		{ apiKey: "test-key", fetch: fetchStub, sessionId, maxRetries: 0, reasoningEffort: "high" },
	);
	for await (const event of events) {
		if (event.type === "done") return event.message;
		if (event.type === "error") return event.error;
	}
	throw new Error("stream ended without done or error");
}

describe("openai-responses reasoning issued to another caller (#1836)", () => {
	const model = getModel("openai", "gpt-5.4");
	const sessionId = "session-1836";

	afterEach(() => cleanupSessionResources(sessionId));

	it("drops the rejected reasoning, answers the turn, and keeps replaying reasoning issued afterwards", async () => {
		const unissued = new Set(["rs_old"]);
		const firstSent: string[][] = [];

		const first = await runTurn(model, contextWith(model, ["rs_old"]), gateway(unissued, firstSent), sessionId);

		expect(first.stopReason).toBe("stop");
		expect(firstSent).toEqual([["rs_old"], []]);

		const laterSent: string[][] = [];
		const later = await runTurn(
			model,
			contextWith(model, ["rs_old", "rs_new"]),
			gateway(unissued, laterSent),
			sessionId,
		);

		expect(later.stopReason).toBe("stop");
		expect(laterSent).toEqual([["rs_new"]]);
	});

	it("leaves an unrelated 400 alone", async () => {
		const sent: string[][] = [];
		const otherRejection = { ...UNISSUED_REJECTION, message: "Invalid value for 'input'." };

		const turn = await runTurn(
			model,
			contextWith(model, ["rs_old"]),
			gateway(new Set(["rs_old"]), sent, otherRejection),
			sessionId,
		);

		expect(turn.stopReason).toBe("error");
		expect(sent).toEqual([["rs_old"]]);
	});
});
