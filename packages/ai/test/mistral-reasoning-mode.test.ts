import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ThinkingLevelMap } from "../src/types.ts";

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: string;
	messages?: Array<{ role?: string; content?: unknown }>;
	promptCacheKey?: string;
}

const NONE_HIGH_LEVELS: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: null,
};
const GLM_5_2_LEVELS: ThinkingLevelMap = { ...NONE_HIGH_LEVELS, max: "max" };
const GLM_5_3_LEVELS: ThinkingLevelMap = { ...NONE_HIGH_LEVELS, off: null, low: "low", max: "max" };

function makeModel(
	id: string,
	reasoning: boolean,
	thinkingLevelMap?: ThinkingLevelMap,
): Model<"mistral-conversations"> {
	return {
		id,
		name: id,
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "http://127.0.0.1:9",
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
	context: Context = makeContext(),
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	// Keep every capture offline: getModel() rows carry the real Mistral base URL.
	const payloadCaptureModel: Model<"mistral-conversations"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const stream = streamSimple(payloadCaptureModel, context, {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Mistral reasoning mode selection", () => {
	it("uses prompt_mode for reasoning models without a thinking level map (Magistral)", async () => {
		const payload = await capturePayload(makeModel("magistral-medium-latest", true), { reasoning: "medium" });

		expect(payload.promptMode).toBe("reasoning");
		expect(payload.reasoningEffort).toBeUndefined();
	});

	it("omits reasoning controls for Magistral when thinking is off", async () => {
		const payload = await capturePayload(makeModel("magistral-medium-latest", true));

		expect(payload.promptMode).toBeUndefined();
		expect(payload.reasoningEffort).toBeUndefined();
	});

	// Regression for #8700 and #9375: Medium and GLM-5.2 ignore Magistral's prompt_mode.
	describe.each(["mistral-small-2603", "mistral-medium-latest", "zai-glm-5-2"] as const)("%s", (modelId) => {
		const map = modelId === "zai-glm-5-2" ? GLM_5_2_LEVELS : NONE_HIGH_LEVELS;

		it("uses reasoning_effort when thinking is enabled", async () => {
			const payload = await capturePayload(makeModel(modelId, true, map), { reasoning: "high" });

			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		});

		it("clamps unsupported levels to a supported effort", async () => {
			const payload = await capturePayload(makeModel(modelId, true, map), { reasoning: "low" });

			expect(payload.reasoningEffort).toBe("high");
		});

		it("sends reasoning_effort none when thinking is off", async () => {
			const payload = await capturePayload(makeModel(modelId, true, map));

			expect(payload.reasoningEffort).toBe("none");
			expect(payload.promptMode).toBeUndefined();
		});
	});

	// Regression for #9678: requested levels must reach Mistral-hosted GLM models.
	it("sends max for GLM-5.2", async () => {
		const payload = await capturePayload(makeModel("zai-glm-5-2", true, GLM_5_2_LEVELS), { reasoning: "max" });

		expect(payload.reasoningEffort).toBe("max");
	});

	describe("zai-glm-5-3", () => {
		it.each(["low", "high", "max"] as const)("sends reasoning_effort %s", async (level) => {
			const payload = await capturePayload(makeModel("zai-glm-5-3", true, GLM_5_3_LEVELS), { reasoning: level });

			expect(payload.reasoningEffort).toBe(level);
			expect(payload.promptMode).toBeUndefined();
		});

		it("maps medium to high", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-3", true, GLM_5_3_LEVELS), { reasoning: "medium" });

			expect(payload.reasoningEffort).toBe("high");
		});
	});

	// Regression for #8700: reasoning controls must respect the model's reasoning capability.
	it("omits reasoning controls for non-reasoning models", async () => {
		const payload = await capturePayload(makeModel("mistral-medium-2505", false), { reasoning: "medium" });

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits standalone same-model thinking replay when thinking is off", async () => {
		const model = getModel("mistral", "mistral-medium-3.5");
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			api: "mistral-conversations",
			provider: "mistral",
			model: model.id,
			content: [
				{ type: "thinking", thinking: "prior reasoning" },
				{ type: "text", text: "previous answer" },
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
			timestamp: Date.now(),
		};
		const payload = await capturePayload(model, undefined, {
			messages: [
				{ role: "user", content: "first turn", timestamp: Date.now() },
				previousAssistant,
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		const assistantMessage = payload.messages?.find((message) => message.role === "assistant");
		expect(JSON.stringify(assistantMessage?.content)).not.toContain('"type":"thinking"');
	});

	it("uses the session id as prompt cache key", async () => {
		const payload = await capturePayload(makeModel("mistral-large-latest", false), {
			sessionId: "session-123",
		});

		expect(payload.promptCacheKey).toBe("session-123");
	});

	it("omits prompt cache key when cache retention is disabled", async () => {
		const payload = await capturePayload(makeModel("mistral-large-latest", false), {
			sessionId: "session-123",
			cacheRetention: "none",
		});

		expect(payload.promptCacheKey).toBeUndefined();
	});
});
