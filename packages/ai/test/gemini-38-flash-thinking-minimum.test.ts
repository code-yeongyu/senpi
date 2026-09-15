import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, SimpleStreamOptions } from "../src/types.ts";

type RuntimeReasoning = NonNullable<SimpleStreamOptions["reasoning"]>;
const RUNTIME_OFF = "off" as unknown as RuntimeReasoning;

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

type GoogleFlashModelId =
	| "gemini-3.8-flash"
	| "gemini-3.7-flash"
	| "gemini-3-flash-preview"
	| "gemini-3.5-flash"
	| "gemini-3.1-pro-preview";

async function capturePayload(
	provider: "google" | "google-vertex",
	modelId: GoogleFlashModelId,
	options: SimpleStreamOptions = {},
): Promise<GenerateContentParameters> {
	const model = getModel(provider, modelId);
	let payload: GenerateContentParameters | undefined;
	const result = await streamSimple(model, context, {
		...options,
		apiKey: "test",
		onPayload: (request) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	}).result();

	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error(`Payload was not captured for ${provider}/${modelId}`);
	return payload;
}

describe("Gemini 3.8/3.7 Flash thinking minimum", () => {
	it("floors omitted reasoning at LOW for google/gemini-3.8-flash", async () => {
		const payload = await capturePayload("google", "gemini-3.8-flash", {});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("floors explicit runtime off at LOW for google/gemini-3.8-flash", async () => {
		const payload = await capturePayload("google", "gemini-3.8-flash", { reasoning: RUNTIME_OFF });

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("floors omitted reasoning at LOW for google/gemini-3.7-flash", async () => {
		const payload = await capturePayload("google", "gemini-3.7-flash", {});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("floors omitted reasoning at LOW for vertex gemini-3.8-flash", async () => {
		const payload = await capturePayload("google-vertex", "gemini-3.8-flash", {});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("floors omitted reasoning at LOW for vertex gemini-3.7-flash", async () => {
		const payload = await capturePayload("google-vertex", "gemini-3.7-flash", {});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("maps explicit minimal to LOW and preserves high for google/gemini-3.8-flash", async () => {
		const minimal = await capturePayload("google", "gemini-3.8-flash", { reasoning: "minimal" });
		expect(minimal.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });

		const high = await capturePayload("google", "gemini-3.8-flash", { reasoning: "high" });
		expect(high.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});

	it("maps explicit minimal to LOW and preserves high for vertex gemini-3.8-flash", async () => {
		const minimal = await capturePayload("google-vertex", "gemini-3.8-flash", { reasoning: "minimal" });
		expect(minimal.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });

		const high = await capturePayload("google-vertex", "gemini-3.8-flash", { reasoning: "high" });
		expect(high.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});

	it("preserves MINIMAL for older Flash with omitted reasoning", async () => {
		const preview = await capturePayload("google", "gemini-3-flash-preview", {});
		expect(preview.config?.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });

		const older = await capturePayload("google", "gemini-3.5-flash", {});
		expect(older.config?.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });

		const vertexPreview = await capturePayload("google-vertex", "gemini-3-flash-preview", {});
		expect(vertexPreview.config?.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
	});

	it("preserves LOW for Pro with omitted reasoning", async () => {
		const googlePro = await capturePayload("google", "gemini-3.1-pro-preview", {});
		expect(googlePro.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });

		const vertexPro = await capturePayload("google-vertex", "gemini-3.1-pro-preview", {});
		expect(vertexPro.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it("uses the session-title option shape without reasoning for google/gemini-3.8-flash", async () => {
		// Mirrors session-title-generator buildTitleOptions over
		// agent-session _buildSessionTitleBaseOptions: no reasoning key, short
		// retention, small max tokens.
		const payload = await capturePayload("google", "gemini-3.8-flash", {
			cacheRetention: "short",
			maxTokens: 64,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});
});
