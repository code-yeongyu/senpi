import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogle } from "../src/api/google-generative-ai.ts";
import { resolveGoogleThinkingLevel, usesGoogleThinkingLevel } from "../src/api/google-shared.ts";
import { streamSimple as streamSimpleVertex } from "../src/api/google-vertex.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Model, ThinkingBudgets, ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
});

function googleModel(id: string, thinkingLevelMap: ThinkingLevelMap): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "test-google",
		baseUrl: "https://example.invalid/v1beta",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function vertexModel(id: string, thinkingLevelMap: ThinkingLevelMap): Model<"google-vertex"> {
	return {
		id,
		name: id,
		api: "google-vertex",
		provider: "test-vertex",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function captureGooglePayload(
	model: Model<"google-generative-ai">,
	reasoning?: ThinkingLevel,
	thinkingBudgets?: ThinkingBudgets,
): Promise<GenerateContentParameters> {
	let payload: GenerateContentParameters | undefined;
	const result = await streamSimpleGoogle(model, context, {
		apiKey: "test",
		reasoning,
		thinkingBudgets,
		onPayload: (request) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	}).result();

	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("Google payload was not captured");
	return payload;
}

async function captureVertexPayload(
	model: Model<"google-vertex">,
	reasoning?: ThinkingLevel,
	thinkingBudgets?: ThinkingBudgets,
): Promise<GenerateContentParameters> {
	let payload: GenerateContentParameters | undefined;
	const result = await streamSimpleVertex(model, context, {
		apiKey: "test",
		reasoning,
		thinkingBudgets,
		onPayload: (request) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	}).result();

	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("Vertex payload was not captured");
	return payload;
}

const googleAdapters = [
	{
		name: "Google Generative AI",
		capture: (id: string, thinkingLevelMap: ThinkingLevelMap, reasoning?: ThinkingLevel) =>
			captureGooglePayload(googleModel(id, thinkingLevelMap), reasoning),
	},
	{
		name: "Google Vertex",
		capture: (id: string, thinkingLevelMap: ThinkingLevelMap, reasoning?: ThinkingLevel) =>
			captureVertexPayload(vertexModel(id, thinkingLevelMap), reasoning),
	},
] as const;

describe("Google thinking level maps", () => {
	it("exhaustively resolves supported logical levels and mapping values", () => {
		const defaultExpectations = {
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
		} as const satisfies Partial<Record<ThinkingLevel, ThinkingLevel>>;
		for (const [level, expected] of Object.entries(defaultExpectations)) {
			expect(resolveGoogleThinkingLevel(googleModel("gemini-3.7-flash", {}), level as ThinkingLevel)).toBe(expected);
		}

		const mappedExpectations = {
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			MINIMAL: "minimal",
			LOW: "low",
			MEDIUM: "medium",
			HIGH: "high",
		} as const;
		for (const [mapped, expected] of Object.entries(mappedExpectations)) {
			const model = googleModel("gemini-3.7-flash", { high: mapped, xhigh: mapped, max: mapped });
			expect(resolveGoogleThinkingLevel(model, "high")).toBe(expected);
			expect(resolveGoogleThinkingLevel(model, "xhigh")).toBe(expected);
			expect(resolveGoogleThinkingLevel(model, "max")).toBe(expected);
		}

		const invalidModel = googleModel("gemini-3.7-flash", { xhigh: "extreme" });
		expect(() => resolveGoogleThinkingLevel(invalidModel, "xhigh")).toThrow(
			"Unsupported Google thinking level mapping for test-google/gemini-3.7-flash: xhigh -> extreme",
		);
		expect(() => resolveGoogleThinkingLevel(googleModel("gemini-3.7-flash", {}), "max")).toThrow(
			"Unsupported Google thinking level mapping for test-google/gemini-3.7-flash: max -> undefined",
		);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/9455
	it.each(googleAdapters)("uses the lowest supported $name level when reasoning is omitted", async ({ capture }) => {
		const payload = await capture("gemini-3.8-flash", {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	it.each(googleAdapters)("preserves native medium effort for Gemini 3.1 Pro on $name", async ({ capture }) => {
		const payload = await capture(
			"gemini-3.1-pro-preview",
			{ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
			"medium",
		);

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
	});

	// gemini-4-argon rejects thinking_budget with HTTP 400; it only accepts LOW/MEDIUM/HIGH levels (senpi#3292).
	const argonMap = {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	} as const satisfies ThinkingLevelMap;

	it.each(googleAdapters)(
		"sends a thinking level, never a budget, for gemini-4-argon on $name",
		async ({ capture }) => {
			const payload = await capture("gemini-4-argon", argonMap, "high");

			expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
		},
	);

	it.each(googleAdapters)("clamps disabled thinking to LOW for gemini-4-argon on $name", async ({ capture }) => {
		const payload = await capture("gemini-4-argon", argonMap);

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
	});

	// Custom models.json and discovery rows usually carry no thinkingLevelMap, so generation 4 and later
	// must still offer only the levels the provider accepts (senpi#3292 review).
	const mapLessAdapters = [
		{
			name: "Google Generative AI",
			model: (id: string) => {
				const { thinkingLevelMap: _omitted, ...rest } = googleModel(id, {});
				return rest;
			},
			capture: (id: string, reasoning?: ThinkingLevel) => {
				const { thinkingLevelMap: _omitted, ...rest } = googleModel(id, {});
				return captureGooglePayload(rest, reasoning);
			},
		},
		{
			name: "Google Vertex",
			model: (id: string) => {
				const { thinkingLevelMap: _omitted, ...rest } = vertexModel(id, {});
				return rest;
			},
			capture: (id: string, reasoning?: ThinkingLevel) => {
				const { thinkingLevelMap: _omitted, ...rest } = vertexModel(id, {});
				return captureVertexPayload(rest, reasoning);
			},
		},
	] as const;

	it.each(mapLessAdapters)("offers only low, medium and high for a map-less gemini-4-argon on $name", ({ model }) => {
		expect(getSupportedThinkingLevels(model("gemini-4-argon"))).toEqual(["low", "medium", "high"]);
	});

	it.each(mapLessAdapters)("raises minimal to LOW for a map-less gemini-4-argon on $name", async ({ capture }) => {
		const payload = await capture("gemini-4-argon", "minimal");

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
	});

	it.each(mapLessAdapters)(
		"clamps disabled thinking to LOW, not a zero budget, for a map-less gemini-4-argon on $name",
		async ({ capture }) => {
			const payload = await capture("gemini-4-argon");

			expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
		},
	);

	it.each(mapLessAdapters)("keeps off and minimal for a map-less gemini-2.5-flash on $name", ({ model }) => {
		expect(getSupportedThinkingLevels(model("gemini-2.5-flash")).slice(0, 2)).toEqual(["off", "minimal"]);
	});

	it.each(["gemini-4", "gemini-4-argon", "gemini-4.5-pro", "models/gemini-4-argon", "gemini-10-x"])(
		"treats %s as generation 4 or later",
		(id) => {
			expect(usesGoogleThinkingLevel(googleModel(id, {}))).toBe(true);
		},
	);

	it.each(["xgemini-4-argon", "gemini-40b", "gemini-embedding-4-001", "gemini-2.5-pro"])(
		"does not treat %s as generation 4 or later",
		(id) => {
			expect(usesGoogleThinkingLevel(googleModel(id, {}))).toBe(false);
		},
	);

	it.each(googleAdapters)("disables Gemini 2.5 thinking when reasoning is omitted on $name", async ({ capture }) => {
		const payload = await capture("gemini-2.5-flash", {});

		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it.each(["xhigh", "max"] as const)("maps Google Generative AI %s to a supported level", async (reasoning) => {
		const payload = await captureGooglePayload(
			googleModel("gemini-3.7-flash", { xhigh: "high", max: "high" }),
			reasoning,
		);

		expect(payload).toMatchObject({ config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } } });
	});

	it("honors uppercase provider values for standard Google Generative AI levels", async () => {
		const payload = await captureGooglePayload(googleModel("gemini-3.7-flash", { high: "LOW" }), "high");

		expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingLevel: "LOW" } } });
	});

	it("uses mapped Google Generative AI levels for token budgets", async () => {
		const payload = await captureGooglePayload(googleModel("gemini-2.5-flash", { xhigh: "high" }), "xhigh", {
			high: 1234,
		});

		expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingBudget: 1234 } } });
	});

	it("maps Google Vertex extended levels", async () => {
		const payload = await captureVertexPayload(vertexModel("gemini-3.7-flash", { xhigh: "high" }), "xhigh");

		expect(payload).toMatchObject({ config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } } });
	});

	it("uses mapped Google Vertex levels for token budgets", async () => {
		const payload = await captureVertexPayload(vertexModel("gemini-2.5-flash", { max: "high" }), "max", {
			high: 4321,
		});

		expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingBudget: 4321 } } });
	});
});
