import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "high";
	messages?: Array<{ role?: string; content?: unknown }>;
	promptCacheKey?: string;
}

function makeModel(id: string, reasoning: boolean): Model<"mistral-conversations"> {
	return {
		id,
		name: id,
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "http://127.0.0.1:9",
		reasoning,
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
	it("uses reasoning_effort for Mistral Small 4", async () => {
		const payload = await capturePayload(makeModel("mistral-small-2603", true), { reasoning: "medium" });

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Small 4 when thinking is off", async () => {
		const payload = await capturePayload(makeModel("mistral-small-2603", true));

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses prompt_mode for Magistral reasoning models", async () => {
		const payload = await capturePayload(makeModel("magistral-medium-latest", true), { reasoning: "medium" });

		expect(payload.promptMode).toBe("reasoning");
		expect(payload.reasoningEffort).toBeUndefined();
	});

	// Regression for #9375: Mistral-hosted GLM-5.2 ignores prompt_mode.
	describe("zai-glm-5-2", () => {
		it("uses reasoning_effort when thinking is enabled", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-2", true), { reasoning: "medium" });

			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		});

		it("omits reasoning controls when thinking is off", async () => {
			const payload = await capturePayload(makeModel("zai-glm-5-2", true));

			expect(payload.reasoningEffort).toBeUndefined();
			expect(payload.promptMode).toBeUndefined();
		});
	});

	// Regression for #8700: Medium aliases must use reasoning_effort, not Magistral's prompt_mode.
	describe.each(["mistral-medium-2604", "mistral-medium-latest"] as const)("%s", (modelId) => {
		it("uses reasoning_effort when thinking is enabled", async () => {
			const payload = await capturePayload(makeModel(modelId, true), { reasoning: "medium" });

			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		});

		it("omits reasoning controls when thinking is off", async () => {
			const payload = await capturePayload(makeModel(modelId, true));

			expect(payload.reasoningEffort).toBeUndefined();
			expect(payload.promptMode).toBeUndefined();
		});
	});

	// Regression for #8700: the Medium prefix must still respect the model's reasoning capability.
	it("omits reasoning controls for non-reasoning Medium models", async () => {
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
