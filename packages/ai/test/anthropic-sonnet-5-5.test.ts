import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { getAnthropicCompat } from "../src/utils/prompt-cache-ttl.ts";

// Claude Sonnet 5.5 (2026-09-28). Facts below were read from the live Models API
// (`GET /v1/models/claude-sonnet-5-5`, `anthropic-beta: server-side-fallback-2026-07-01`)
// and live Messages requests on 2026-09-29: thinking `enabled: unsupported` /
// `adaptive: supported`, effort low..max, 1M in / 128k out, `allowed_fallback_models:
// ["claude-sonnet-5"]`, price 2/10 with 0.1 cache reads (0.05x input, per
// https://platform.claude.com/docs/en/about-claude/pricing); `thinking.type=disabled` and
// `tool_choice` `tool`/`any` are 400s, exactly like Claude Opus 5.5.

interface AnthropicPayload {
	messages: Array<{ role: string; output_config?: { effort?: string } }>;
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	tool_choice?: { type: string };
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
): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await s.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

function sonnet55(): Model<"anthropic-messages"> {
	const model = getModel("anthropic", "claude-sonnet-5-5");
	expect(model, "anthropic/claude-sonnet-5-5 must exist in the generated catalog").toBeDefined();
	return model as Model<"anthropic-messages">;
}

describe("Claude Sonnet 5.5 catalog row (anthropic)", () => {
	it("carries the documented limits, prices and effort tiers", () => {
		const model = sonnet55();
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("is adaptive-only and rejects forced tool choice, like Opus 5.5", () => {
		const model = sonnet55();
		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.compat?.supportsDisabledThinking).toBe(false);
		expect(getAnthropicCompat(model).supportsForcedToolChoice).toBe(false);
	});
});

describe("Claude Sonnet 5.5 request shape", () => {
	it("never sends thinking.type=disabled: a thinking-off turn pins the cheapest effort instead", async () => {
		const payload = await capturePayload(sonnet55());
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("pins effort low for a gateway row carrying the Sonnet 5.5 id with no catalog metadata", async () => {
		const { thinkingLevelMap: _thinkingLevelMap, ...rest } = sonnet55();
		const custom: Model<"anthropic-messages"> = { ...rest, provider: "custom-gateway", compat: {} };
		const payload = await capturePayload(custom);
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("runs adaptive thinking with max effort for the built-in row", async () => {
		const payload = await capturePayload(sonnet55(), { reasoning: "max" });
		expect(payload.thinking).toMatchObject({ type: "adaptive" });
		expect(payload.thinking?.budget_tokens).toBeUndefined();
	});

	it("rejects forced tool choice for a dotted gateway spelling too", () => {
		const custom: Model<"anthropic-messages"> = { ...sonnet55(), id: "claude-sonnet-5.5", provider: "openrouter" };
		expect(getAnthropicCompat(custom).supportsForcedToolChoice).toBe(false);
	});
});
