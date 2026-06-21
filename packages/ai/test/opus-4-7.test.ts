import { describe, expect, it } from "vitest";
import { getModel, supportsXhigh } from "../src/models.ts";
import "../src/providers/register-builtins.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayloadWithReasoning(
	model: Model<"anthropic-messages">,
	reasoning: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		apiKey: "fake-key",
		reasoning,
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Claude Opus 4.7 model catalog", () => {
	it("exposes claude-opus-4-7 on anthropic provider with 1M context and 128k max tokens", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		expect(model!.id).toBe("claude-opus-4-7");
		expect(model!.api).toBe("anthropic-messages");
		expect(model!.reasoning).toBe(true);
		expect(model!.contextWindow).toBe(1_000_000);
		expect(model!.maxTokens).toBe(128_000);
	});

	it("exposes Bedrock cross-region Opus 4.7 profiles (us, eu, global)", () => {
		const us = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7-v1");
		const eu = getModel("amazon-bedrock", "eu.anthropic.claude-opus-4-7-v1");
		const global = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-7-v1");
		expect(us).toBeDefined();
		expect(eu).toBeDefined();
		expect(global).toBeDefined();
	});
});

describe("supportsXhigh for Opus 4.7", () => {
	it("returns true for Anthropic Opus 4.7", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});
});

describe("Anthropic adaptive thinking for Opus 4.7", () => {
	it("maps reasoning=xhigh to adaptive effort=xhigh", async () => {
		const payload = await capturePayloadWithReasoning(getModel("anthropic", "claude-opus-4-7"), "xhigh");
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps reasoning=high to adaptive effort=high", async () => {
		const payload = await capturePayloadWithReasoning(getModel("anthropic", "claude-opus-4-7"), "high");
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("disables thinking when no reasoning provided", async () => {
		const payload = await capturePayloadWithReasoning(getModel("anthropic", "claude-opus-4-7"), undefined);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});
});

describe("Anthropic Opus 4.6 xhigh keeps mapping to effort=max", () => {
	it("still maps xhigh to max for Opus 4.6", async () => {
		const payload = await capturePayloadWithReasoning(getModel("anthropic", "claude-opus-4-6"), "xhigh");
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});
});

describe("Anthropic Opus 4.7 native max effort", () => {
	it("maps reasoning=max to adaptive effort=max on Opus 4.7", async () => {
		const payload = await capturePayloadWithReasoning(getModel("anthropic", "claude-opus-4-7"), "max");
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps reasoning=max to adaptive effort=max on Opus 4.6 too (legacy parity)", async () => {
		const payload = await capturePayloadWithReasoning(getModel("anthropic", "claude-opus-4-6"), "max");
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("clamps reasoning=max to budget-based thinking on non-adaptive Anthropic models", async () => {
		const payload = await capturePayloadWithReasoning(getModel("anthropic", "claude-sonnet-4-5"), "max");
		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.output_config).toBeUndefined();
	});
});
