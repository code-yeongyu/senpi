import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };

	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});
	await s.result();
	if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");
	return capturedPayload;
}

/** Literal-typed fixtures: getModel() only accepts known catalog ids. */
const FIXTURES = {
	"claude-opus-4-8": () => getModel("anthropic", "claude-opus-4-8"),
	"claude-opus-5": () => getModel("anthropic", "claude-opus-5"),
	"claude-sonnet-5": () => getModel("anthropic", "claude-sonnet-5"),
	"claude-sonnet-4-6": () => getModel("anthropic", "claude-sonnet-4-6"),
	"claude-fable-5": () => getModel("anthropic", "claude-fable-5"),
} as const;

type FixtureId = keyof typeof FIXTURES;

/** Drops thinkingLevelMap so the request exercises the marker-based effort fallback. */
function mapless(id: FixtureId): Model<"anthropic-messages"> {
	const base = FIXTURES[id]() as Model<"anthropic-messages">;
	const { thinkingLevelMap: _thinkingLevelMap, ...rest } = base;
	return rest as Model<"anthropic-messages">;
}

/** Drops both the map and the adaptive compat pin so only ADAPTIVE_THINKING_MODEL_MARKERS decides. */
function maplessUnflagged(id: FixtureId): Model<"anthropic-messages"> {
	const base = mapless(id);
	const { forceAdaptiveThinking: _forceAdaptiveThinking, ...compat } = base.compat ?? {};
	return { ...base, compat };
}

describe("Anthropic adaptive effort fallback for map-less models", () => {
	it("maps xhigh to the native xhigh tier for a map-less Opus 5", async () => {
		const payload = await capturePayload(mapless("claude-opus-5"), { reasoning: "xhigh" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps xhigh to the native xhigh tier for a map-less Fable 5", async () => {
		const payload = await capturePayload(mapless("claude-fable-5"), { reasoning: "xhigh" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps max to max for a map-less Sonnet 4.6", async () => {
		const payload = await capturePayload(mapless("claude-sonnet-4-6"), { reasoning: "max" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps xhigh down to max for a map-less Sonnet 4.6 without a native xhigh tier", async () => {
		const payload = await capturePayload(mapless("claude-sonnet-4-6"), { reasoning: "xhigh" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps max to max for a map-less Opus 5", async () => {
		const payload = await capturePayload(mapless("claude-opus-5"), { reasoning: "max" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});
});

describe("Anthropic adaptive detection without the compat pin", () => {
	it.each<FixtureId>([
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-fable-5",
	])("treats %s as adaptive from the model marker alone", async (id) => {
		const payload = await capturePayload(maplessUnflagged(id), { reasoning: "high" });
		expect(payload.thinking?.type).toBe("adaptive");
	});
});
