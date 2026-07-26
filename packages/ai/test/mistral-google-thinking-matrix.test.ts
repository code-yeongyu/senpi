import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

/**
 * Task-12 wire audit: adapter x thinking-level matrix.
 *
 * `reasoning` is typed as ThinkingLevel (no "off"), but the agent layer and
 * extension hosts can hand a runtime "off" through (clampThinkingLevel accepts
 * ModelThinkingLevel explicitly). These tests pin the exact wire fields for
 * every level, and prove that a runtime thinking-OFF request can never fall
 * through to an enabled/high reasoning wire form.
 */

type RuntimeReasoning = NonNullable<SimpleStreamOptions["reasoning"]>;
const RUNTIME_OFF = "off" as unknown as RuntimeReasoning;

interface MistralWirePayload {
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "high";
}

interface GoogleWirePayload {
	model?: string;
	config?: {
		thinkingConfig?: Record<string, unknown>;
	};
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function captureMistralPayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
): Promise<MistralWirePayload> {
	let captured: MistralWirePayload | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as MistralWirePayload;
			return payload;
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected Mistral payload to be captured before request failure");
	return captured;
}

async function captureGooglePayload<TApi extends "google-generative-ai" | "google-vertex">(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): Promise<GoogleWirePayload> {
	let captured: GoogleWirePayload | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" } as Model<TApi>, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as GoogleWirePayload;
			return payload;
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected Google payload to be captured before request failure");
	return captured;
}

describe("Mistral thinking-off wire audit", () => {
	it("explicit runtime off omits reasoning controls for effort models", async () => {
		const payload = await captureMistralPayload(getModel("mistral", "mistral-small-2603"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("explicit runtime off omits reasoning controls for prompt-mode models", async () => {
		const payload = await captureMistralPayload(getModel("mistral", "magistral-medium-latest"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("maps every enabled level onto the two-state wire effort", async () => {
		for (const level of ["minimal", "low", "medium", "high"] as const) {
			const payload = await captureMistralPayload(getModel("mistral", "mistral-small-2603"), {
				reasoning: level,
			});
			expect(payload.reasoningEffort).toBe("high");
			expect(payload.promptMode).toBeUndefined();
		}
	});
});

describe("Google Generative AI thinking-off wire audit", () => {
	it("explicit runtime off disables thinking via thinkingBudget 0 for Gemini 2.5", async () => {
		const payload = await captureGooglePayload(getModel("google", "gemini-2.5-flash"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it("explicit runtime off floors Gemini 3 Flash at MINIMAL without includeThoughts", async () => {
		const payload = await captureGooglePayload(getModel("google", "gemini-3-flash-preview"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
	});

	it("explicit runtime off floors Gemini 3.1 Pro at LOW without includeThoughts", async () => {
		const payload = await captureGooglePayload(getModel("google", "gemini-3.1-pro-preview"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("maps medium to thinkingLevel MEDIUM for Gemini 3 Flash", async () => {
		const payload = await captureGooglePayload(getModel("google", "gemini-3-flash-preview"), {
			reasoning: "medium",
		});

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
	});

	it("maps low to thinkingBudget 2048 for Gemini 2.5 Flash", async () => {
		const payload = await captureGooglePayload(getModel("google", "gemini-2.5-flash"), { reasoning: "low" });

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 2048 });
	});

	it("clamps unsupported xhigh down to the high budget for Gemini 2.5 Flash", async () => {
		const payload = await captureGooglePayload(getModel("google", "gemini-2.5-flash"), { reasoning: "xhigh" });

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24576 });
	});
});

describe("Google Vertex thinking-off wire audit", () => {
	it("explicit runtime off disables thinking via thinkingBudget 0 for Gemini 2.5", async () => {
		const payload = await captureGooglePayload(getModel("google-vertex", "gemini-2.5-flash"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it("explicit runtime off floors Gemini 3 Flash at MINIMAL without includeThoughts", async () => {
		const payload = await captureGooglePayload(getModel("google-vertex", "gemini-3-flash-preview"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
	});

	it("explicit runtime off floors Gemini 3.1 Pro at LOW without includeThoughts", async () => {
		const payload = await captureGooglePayload(getModel("google-vertex", "gemini-3.1-pro-preview"), {
			reasoning: RUNTIME_OFF,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("maps high to thinkingLevel HIGH for Gemini 3.1 Pro", async () => {
		const payload = await captureGooglePayload(getModel("google-vertex", "gemini-3.1-pro-preview"), {
			reasoning: "high",
		});

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});
});
