import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface CapturedPromptCachePayload {
	prompt_cache_options?: Record<string, unknown>;
}

function assistant(
	model: Model<"openai-responses">,
	responseId: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "earlier answer" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	};
}

async function capturePromptCacheOptions(
	model: Model<"openai-responses">,
	messages: Message[],
	cacheRetention?: "none" | "short" | "long",
): Promise<Record<string, unknown> | undefined> {
	let captured: CapturedPromptCachePayload | undefined;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	const events = streamOpenAIResponses(model, normalizeContext({ systemPrompt: "sys", messages }), {
		apiKey: "test-key",
		sessionId: "session-2096",
		cacheRetention,
		onPayload: (payload) => {
			captured = payload as CapturedPromptCachePayload;
		},
	});
	for await (const event of events) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured?.prompt_cache_options;
}

function history(...assistants: AssistantMessage[]): Message[] {
	return [
		{ role: "user", content: "first", timestamp: 1 },
		...assistants.flatMap((message): Message[] => [message, { role: "user", content: "next", timestamp: 3 }]),
	];
}

// senpi#2096: every GPT-5.6+ request compares against the previous same-model response.
describe("openai-responses prompt_cache_options.comparison_response_id", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends the previous same-model response id and keeps ttl/mode unchanged", async () => {
		const luna = getModel("openai", "gpt-6-luna");
		const messages = history(assistant(luna, "resp_older"), assistant(luna, "resp_previous"));

		await expect(capturePromptCacheOptions(luna, messages)).resolves.toEqual({
			comparison_response_id: "resp_previous",
		});
		await expect(capturePromptCacheOptions(luna, messages, "long")).resolves.toEqual({
			ttl: "30m",
			comparison_response_id: "resp_previous",
		});
	});

	it("skips failed turns and responses of other models", async () => {
		const luna = getModel("openai", "gpt-6-luna");
		const other = { ...luna, id: "gpt-6-sol" };
		const messages = history(
			assistant(luna, "resp_ok"),
			assistant(luna, "resp_failed", "error"),
			assistant(other, "resp_other"),
		);

		await expect(capturePromptCacheOptions(luna, messages)).resolves.toEqual({ comparison_response_id: "resp_ok" });
	});

	// senpi#2118: the platform rejects a comparison id that does not begin with `resp` with HTTP 400.
	it("omits the comparison when the previous response id is not a Responses id", async () => {
		const luna = getModel("openai", "gpt-6-luna");
		const messages = history(assistant(luna, "resp_older"), assistant(luna, "chatcmpl-previous"));

		await expect(capturePromptCacheOptions(luna, messages)).resolves.toBeUndefined();
	});

	it("omits the comparison when only another provider produced the previous response", async () => {
		const luna = getModel("openai", "gpt-6-luna");
		const otherProvider = { ...luna, provider: "openai-proxy" };

		await expect(
			capturePromptCacheOptions(luna, history(assistant(otherProvider, "resp_from_proxy"))),
		).resolves.toBeUndefined();
	});

	it("omits the comparison without a previous response, for cacheRetention none, and off api.openai.com", async () => {
		const luna = getModel("openai", "gpt-6-luna");
		const messages = history(assistant(luna, "resp_previous"));
		const proxy: Model<"openai-responses"> = { ...luna, baseUrl: "https://proxy.example.com/v1" };

		await expect(capturePromptCacheOptions(luna, history())).resolves.toBeUndefined();
		await expect(capturePromptCacheOptions(luna, messages, "none")).resolves.toEqual({ mode: "explicit" });
		await expect(capturePromptCacheOptions(proxy, history(assistant(proxy, "resp_proxy")))).resolves.toBeUndefined();
		const gpt55 = getModel("openai", "gpt-5.5");
		await expect(capturePromptCacheOptions(gpt55, history(assistant(gpt55, "resp_55")))).resolves.toBeUndefined();
	});
});
