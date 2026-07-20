import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, stream } from "../src/compat.ts";
import { fauxAssistantMessage, registerFauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessageEvent, Context } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { isClassifierRefusal } from "../src/utils/stop-details.ts";

function createSseResponse(
	stopReason: "refusal" | "sensitive" | "end_turn" | "max_tokens",
	stopDetails?: { explanation?: string },
): Response {
	const events = [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_stop_details",
					usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			}),
		},
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: stopReason, stop_details: stopDetails },
				usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
	return new Response(events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

async function collectEvents(streamResult: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) events.push(event);
	return events;
}

const context: Context = { messages: [{ role: "user", content: "blocked", timestamp: 1 }] };

describe("classifier stop details", () => {
	it("maps Anthropic refusal and sensitive stops to typed error details", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const refusal = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse("refusal", { explanation: "policy classifier" })),
		}).result();
		const sensitive = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse("sensitive")),
		}).result();

		expect(refusal).toMatchObject({
			stopReason: "error",
			errorMessage: "policy classifier",
			stopDetails: { type: "refusal", explanation: "policy classifier" },
		});
		expect(sensitive).toMatchObject({ stopReason: "error", stopDetails: { type: "sensitive" } });
		expect(isClassifierRefusal(refusal)).toBe(true);
		expect(isClassifierRefusal(sensitive)).toBe(true);
	});

	it("leaves successful and length-limited Anthropic stops unclassified", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const completed = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse("end_turn")),
		}).result();
		const lengthLimited = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse("max_tokens")),
		}).result();

		expect(completed.stopReason).toBe("stop");
		expect(completed.stopDetails).toBeUndefined();
		expect(isClassifierRefusal(completed)).toBe(false);
		expect(lengthLimited.stopReason).toBe("length");
		expect(lengthLimited.stopDetails).toBeUndefined();
		expect(isClassifierRefusal(lengthLimited)).toBe(false);
	});

	it("recognizes only typed classifier errors", () => {
		const classifierRefusal = fauxAssistantMessage("", { stopReason: "error", stopDetails: { type: "refusal" } });
		const classifierSensitive = fauxAssistantMessage("", { stopReason: "error", stopDetails: { type: "sensitive" } });
		const nonError = fauxAssistantMessage("", { stopDetails: { type: "refusal" } });
		const absent = { ...classifierRefusal, stopDetails: undefined };

		expect(isClassifierRefusal(classifierRefusal)).toBe(true);
		expect(isClassifierRefusal(classifierSensitive)).toBe(true);
		expect(isClassifierRefusal(nonError)).toBe(false);
		expect(isClassifierRefusal(absent)).toBe(false);
	});

	it("passes classifier details through faux error stream events and excludes them from retry", async () => {
		const registration = registerFauxProvider();
		registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded",
				stopDetails: { type: "refusal", explanation: "classified" },
			}),
		]);

		const events = await collectEvents(stream(registration.getModel(), context));
		const errorEvent = events.find((event) => event.type === "error");
		expect(errorEvent).toMatchObject({
			type: "error",
			error: { stopReason: "error", stopDetails: { type: "refusal", explanation: "classified" } },
		});
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "overloaded",
					stopDetails: { type: "refusal" },
				}),
			),
		).toBe(false);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "overloaded",
					stopDetails: { type: "sensitive" },
				}),
			),
		).toBe(false);
		registration.unregister();
	});
});
