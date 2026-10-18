import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { parseEndpointReasoningEfforts } from "../src/endpoint-reasoning-efforts.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model, SimpleStreamOptions, ThinkingLevelMap } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#2196: OpenAI-compatible /models listings advertise per-model reasoning_efforts.
describe("parseEndpointReasoningEfforts", () => {
	it("maps advertised values onto senpi levels, keeps the endpoint spelling, and vetoes the rest", () => {
		const parsed = parseEndpointReasoningEfforts([{ value: "low" }, { value: "High", default: true }]);

		expect(parsed).toEqual({
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: null,
				high: "High",
				xhigh: null,
				max: null,
			},
			defaultThinkingLevel: "high",
			unmapped: [],
		});
	});

	it("maps none/off to the off level and accepts plain string entries", () => {
		const parsed = parseEndpointReasoningEfforts(["none", "medium", "xhigh", "max"]);

		expect(parsed?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: "max",
		});
		expect(parsed?.defaultThinkingLevel).toBeUndefined();
	});

	it("reports names it cannot map and never uses them as the default", () => {
		const parsed = parseEndpointReasoningEfforts([
			{ value: "turbo", default: true },
			{ value: "low" },
			{ value: "LOW" },
		]);

		expect(parsed?.unmapped).toEqual(["turbo"]);
		expect(parsed?.defaultThinkingLevel).toBeUndefined();
		expect(parsed?.thinkingLevelMap?.low).toBe("low");
	});

	it("treats inherited object property names as unknown names (review B3)", () => {
		const parsed = parseEndpointReasoningEfforts([
			{ value: "__proto__", default: true },
			{ value: "constructor" },
			{ value: "toString" },
		]);

		expect(parsed).toEqual({ unmapped: ["__proto__", "constructor", "toString"] });
	});

	it("distinguishes an advertised ladder with nothing representable from absent metadata (review B1)", () => {
		expect(parseEndpointReasoningEfforts([{ value: "turbo" }])).toEqual({ unmapped: ["turbo"] });
		expect(parseEndpointReasoningEfforts([])).toEqual({ unmapped: [] });
		expect(parseEndpointReasoningEfforts([{ value: 3 }, null, { default: true }])).toEqual({ unmapped: [] });
		expect(parseEndpointReasoningEfforts(undefined)).toBeUndefined();
		expect(parseEndpointReasoningEfforts({ value: "low" })).toBeUndefined();
	});
});

const LOW_HIGH = parseEndpointReasoningEfforts([{ value: "low" }, { value: "High", default: true }]);
const NONE_LOW_HIGH = parseEndpointReasoningEfforts(["none", "low", "high"]);

function endpointModel(id: string, thinkingLevelMap: ThinkingLevelMap | undefined): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "local-endpoint",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: { supportsReasoningEffort: true },
	};
}

async function sentReasoningEffort(
	model: Model<"openai-completions">,
	reasoning: SimpleStreamOptions["reasoning"],
): Promise<unknown> {
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
	let sent: unknown = "payload was never built";
	const result = streamSimple(model, normalizeContext(context), {
		apiKey: "fake-key",
		...(reasoning === undefined ? {} : { reasoning }),
		onPayload: (payload) => {
			sent = typeof payload === "object" && payload !== null ? Reflect.get(payload, "reasoning_effort") : undefined;
			return payload;
		},
	});
	await result.result();
	return sent;
}

describe("models configured from endpoint reasoning efforts", () => {
	it("offers only the advertised levels, skipping id-based inference", () => {
		expect(getSupportedThinkingLevels(endpointModel("gpt-5.5", LOW_HIGH?.thinkingLevelMap))).toEqual(["low", "high"]);
		expect(clampThinkingLevel(endpointModel("effort-model", LOW_HIGH?.thinkingLevelMap), "medium")).toBe("high");
	});

	it("sends the endpoint's original effort name on the wire", async () => {
		expect(await sentReasoningEffort(endpointModel("effort-model", LOW_HIGH?.thinkingLevelMap), "high")).toBe("High");
	});

	// review B2: an advertised off sentinel is what "reasoning off" sends, for every model id.
	it.each(["effort-model", "gpt-6-astra"])(
		"sends the advertised off value for %s when reasoning is off",
		async (id) => {
			expect(await sentReasoningEffort(endpointModel(id, NONE_LOW_HIGH?.thinkingLevelMap), undefined)).toBe("none");
		},
	);

	it("keeps the map-less gpt-6-astra off -> low normalization", async () => {
		expect(await sentReasoningEffort(endpointModel("gpt-6-astra", undefined), undefined)).toBe("low");
	});
});
