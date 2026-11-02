import { describe, expect, it } from "vitest";
import { getModel, getModels, streamSimple } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

// Claude Opus 5.5 (2026-09-22). Facts below were read from the live Models API
// (`GET /v1/models/claude-opus-5-5` with `anthropic-beta: server-side-fallback-2026-07-01`):
// thinking `enabled: unsupported` / `adaptive: supported`, effort low..max, 1M in / 128k out,
// `allowed_fallback_models: ["claude-opus-4-8", "claude-opus-5"]`, price 4/20 with 0.2 cache reads.

interface AnthropicThinkingPayload {
	messages: Array<{ role: string; output_config?: { effort?: string } }>;
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let captured: AnthropicThinkingPayload | undefined;
	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});
	await s.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

function opus55(): Model<"anthropic-messages"> {
	const model = getModel("anthropic", "claude-opus-5-5");
	expect(model, "anthropic/claude-opus-5-5 must exist in the generated catalog").toBeDefined();
	return model as Model<"anthropic-messages">;
}

describe("Claude Opus 5.5 catalog row (anthropic)", () => {
	it("carries the documented limits, prices and effort tiers", () => {
		const model = opus55();
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("is adaptive-only with per-message effort, and names only mid-conversation-effort peers as fallbacks", () => {
		const model = opus55();
		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.compat?.supportsDisabledThinking).toBe(false);
		expect(model.compat?.supportsMidConvoEffort).toBe(true);
		// Live allowlist is [opus-4-8, opus-5]; the generator keeps only targets that also support
		// per-message effort (a managed-effort primary cannot hand a conversation to a budget model).
		const fallbackIds = model.compat?.allowedFallbackModels?.map((fallback) =>
			typeof fallback === "string" ? fallback : fallback.model,
		);
		expect(fallbackIds).toEqual(["claude-opus-5"]);
	});
});

describe("Claude Opus 5.5 catalog rows (other providers)", () => {
	it("exposes Bedrock Opus 5.5 through inference profiles only, like Opus 5", () => {
		const bedrock = getModels("amazon-bedrock");
		expect(bedrock.some((model) => model.id === "global.anthropic.claude-opus-5-5")).toBe(true);
		expect(bedrock.some((model) => model.id === "anthropic.claude-opus-5-5")).toBe(false);
		const global = getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");
		expect(getSupportedThinkingLevels(global)).toContain("xhigh");
		expect(getSupportedThinkingLevels(global)).toContain("max");
		expect(global.thinkingLevelMap?.off).toBeNull();
	});
});

describe("Claude Opus 5.5 request shape", () => {
	it("never sends thinking.type=disabled: a thinking-off turn pins the cheapest effort instead", async () => {
		const payload = await capturePayload(opus55());
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("pins effort low for a gateway row carrying the Opus 5.5 id with no catalog metadata", async () => {
		const { thinkingLevelMap: _thinkingLevelMap, ...rest } = opus55();
		const custom: Model<"anthropic-messages"> = { ...rest, provider: "custom-gateway", compat: {} };
		const payload = await capturePayload(custom);
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("runs adaptive thinking with per-message max effort for the built-in row", async () => {
		const payload = await capturePayload(opus55(), { reasoning: "max" });
		expect(payload.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(payload.thinking?.budget_tokens).toBeUndefined();
		expect(payload.messages.at(-1)).toMatchObject({ output_config: { effort: "max" } });
	});

	it.each([
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("maps reasoning %s to native effort %s on a map-less Opus 5.5 row", async (reasoning, effort) => {
		const { thinkingLevelMap: _thinkingLevelMap, compat: _compat, ...rest } = opus55();
		const custom: Model<"anthropic-messages"> = { ...rest, provider: "custom-gateway" };
		const payload = await capturePayload(custom, { reasoning });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort });
	});
});
