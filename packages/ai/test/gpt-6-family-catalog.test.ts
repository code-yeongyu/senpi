import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModel, getModels, getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

/**
 * GPT-6 Sol and GPT-6 Luna (developers.openai.com/api/docs/guides/latest-model,
 * 2026-09-23): the two non-Astra tiers of the GPT-6 family. Both document
 * `reasoning.effort` none/low/medium/high/xhigh/max, a 1,050,000-token window
 * with a 922,000-token input cap, 128,000 output tokens, text + image input,
 * and the >272k long-context multipliers (2x input/cache, 1.5x output).
 *
 * GPT-6.1 Sol (developers.openai.com/api/docs/models/gpt-6.1-sol, 2026-09-29) keeps
 * Sol's window, output limit and input/output prices, halves cached input to 0.1,
 * and documents low/medium/high/xhigh/max only: like Astra, it has no `none`.
 *
 * Published list prices per MTok: Sol 2 / 10 (cache read 0.2, write 2.5),
 * 6.1 Sol 2 / 10 (cache read 0.1, write 2.5), Luna 0.1 / 0.5 (cache read 0.01,
 * write 0.125).
 *
 * Project defaults for the prompt budget (`contextWindow` is the prompt budget,
 * not the documented window): Luna ships the full 922,000 input cap, Sol and
 * 6.1 Sol ship 400,000, Astra keeps 600,000. Like Astra, each tier's number is
 * stamped on every provider catalog so the budget does not change with the route.
 */
const SOL_CONTEXT_WINDOW = 400_000;
const LUNA_CONTEXT_WINDOW = 922_000;

const EXPECTED = {
	"gpt-6-sol": {
		name: "GPT-6 Sol",
		contextWindow: SOL_CONTEXT_WINDOW,
		supportsNone: true,
		cost: {
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
			tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
		},
	},
	"gpt-6.1-sol": {
		name: "GPT-6.1 Sol",
		contextWindow: SOL_CONTEXT_WINDOW,
		supportsNone: false,
		cost: {
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheWrite: 2.5,
			tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
		},
	},
	"gpt-6-luna": {
		name: "GPT-6 Luna",
		contextWindow: LUNA_CONTEXT_WINDOW,
		supportsNone: true,
		cost: {
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
		},
	},
} as const;

type FamilyId = keyof typeof EXPECTED;
const FAMILY_IDS = Object.keys(EXPECTED) as FamilyId[];

for (const provider of ["openai", "chatgpt-subscription"] as const) {
	for (const id of FAMILY_IDS) {
		describe(`${provider}/${id}`, () => {
			it("has the published catalog metadata and long-context pricing", () => {
				const model = getModel(provider, id);
				expect(model).toMatchObject({
					id,
					name: EXPECTED[id].name,
					api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
					provider,
					baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: EXPECTED[id].contextWindow,
					maxTokens: 128000,
					cost: EXPECTED[id].cost,
				});
			});

			it("exposes the documented reasoning efforts, with minimal absent and off only where none is documented", () => {
				const model = getModel(provider, id)!;
				// Sol and Luna accept `none`; Astra and 6.1 Sol do not; the GPT-6 ladder has no `minimal` anywhere.
				expect(model.thinkingLevelMap).toMatchObject({
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				});
				if (!EXPECTED[id].supportsNone) {
					expect(model.thinkingLevelMap?.off).toBeNull();
				} else if (provider === "openai") {
					expect(model.thinkingLevelMap?.off).toBe("none");
				}
				const ladder = ["low", "medium", "high", "xhigh", "max"];
				expect(getSupportedThinkingLevels(model)).toEqual(EXPECTED[id].supportsNone ? ["off", ...ladder] : ladder);
				expect(supportsXhigh(model)).toBe(true);
				expect(supportsMax(model)).toBe(true);
			});

			it("exposes the tool-search and additional-tools metadata", () => {
				const model = getModel(provider, id)!;
				const compat = model.compat as
					| { supportsToolSearch?: boolean; supportsAdditionalTools?: boolean }
					| undefined;
				expect(compat?.supportsToolSearch).toBe(true);
				expect(compat?.supportsAdditionalTools).toBe(true);
			});

			it("has a priority fast variant", () => {
				const fast = getModel(provider, `${id}-fast`);
				expect(fast).toMatchObject({
					id: `${id}-fast`,
					upstreamModelId: id,
					serviceTier: "priority",
					contextWindow: EXPECTED[id].contextWindow,
				});
			});
		});
	}
}

describe("ChatGPT Subscription GPT-6.1 Sol Ultrafast", () => {
	it("ships a subscription-only alias with Sol capabilities and unchanged cost metadata", () => {
		const base = getModel("chatgpt-subscription", "gpt-6.1-sol");
		const ultrafast = getModel("chatgpt-subscription", "gpt-6.1-sol-ultrafast");
		expect(ultrafast).toEqual({
			...base,
			id: "gpt-6.1-sol-ultrafast",
			name: "GPT-6.1 Sol Ultrafast",
			upstreamModelId: "gpt-6.1-sol",
			serviceTier: "ultrafast",
			defaultThinkingLevel: "xhigh",
		});
		expect(ultrafast?.cost).toEqual(EXPECTED["gpt-6.1-sol"].cost);
		expect(ultrafast && getSupportedThinkingLevels(ultrafast)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(getModels("openai").some((model) => model.id === "gpt-6.1-sol-ultrafast")).toBe(false);
	});
});

// A map-less model exercises the id-based inference in models.ts
// (XHIGH_MODEL_IDS / OPENAI_MAX_MODEL_IDS / OPENAI_MAX_APIS) directly, so a
// custom provider that ships the bare id still surfaces xhigh and max, and keeps
// `off` selectable exactly where the tier documents `none` (Sol, Luna) while a
// map-less 6.1 Sol takes the Astra-shaped map that vetoes it.
function maplessModel(id: FamilyId, api: Api): Model<Api> {
	return {
		id,
		name: EXPECTED[id].name,
		api,
		provider: "custom",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

describe("GPT-6 Sol/6.1 Sol/Luna effort inference without a thinking-level map", () => {
	for (const id of FAMILY_IDS) {
		for (const api of [
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"openai-completions",
		] as const) {
			it(`infers xhigh and max and ${EXPECTED[id].supportsNone ? "keeps" : "vetoes"} off for a map-less ${id} on ${api}`, () => {
				const model = maplessModel(id, api);
				expect(supportsXhigh(model)).toBe(true);
				expect(supportsMax(model)).toBe(true);
				const levels = getSupportedThinkingLevels(model);
				if (EXPECTED[id].supportsNone) {
					expect(levels).toContain("off");
				} else {
					expect(levels).not.toContain("off");
				}
				expect(levels).toContain("xhigh");
				expect(levels).toContain("max");
			});
		}
	}
});

// Every catalog that ships a tier declares that tier's project default budget,
// mirroring gpt-6-astra-context-window.test.ts for the rest of the family.
const dataDirectory = fileURLToPath(new URL("../src/providers/data/", import.meta.url));

type CatalogEntry = { id?: unknown; contextWindow?: unknown };
type FamilyEntry = { file: string; api: string; id: string; contextWindow: unknown };
type Catalog = Record<string, Record<string, CatalogEntry>>;

/**
 * Whether a catalog key names OpenAI's own chat model of this tier. The WHOLE key must be one of the shapes routes give
 * OpenAI's models, anchored at both ends:
 * - `chat:` - a classifier or image row is never the tier's chat model;
 * - the vendor form: bare (`gpt-6-luna`), `openai/` (OpenRouter, gateways), `openai-` (Venice), or Bedrock's dotted
 *   `openai.` with an optional region (`global.`, `us.`);
 * - the tier name, then only `-fast` or `-pro`, then only `:batch`, then the end of the key.
 * A third party's model whose id merely contains the tier name is somebody else's product with its own window. The
 * release regenerates catalogs from live provider lists, which do list such models, for example OpenRouter's
 * `classifier:openai/gpt-6-luna-decisions`.
 */
function isOpenAIFamilyModel(key: string, marker: FamilyId): boolean {
	const tier = marker.replaceAll(".", "\\.");
	return new RegExp(`^chat:(?:(?:[a-z]{2,6}\\.)?openai\\.|openai[/-])?${tier}(?:-fast|-pro)?(?::batch)?$`, "u").test(
		key,
	);
}

function collectFamilyEntriesFrom(catalogs: ReadonlyMap<string, Catalog>, marker: FamilyId): FamilyEntry[] {
	const entries: FamilyEntry[] = [];
	for (const [file, parsed] of catalogs) {
		for (const [api, models] of Object.entries(parsed)) {
			if (!models || typeof models !== "object") continue;
			for (const [id, model] of Object.entries(models)) {
				if (!isOpenAIFamilyModel(id, marker)) continue;
				entries.push({ file, api, id, contextWindow: model?.contextWindow });
			}
		}
	}
	return entries;
}

function shippedCatalogs(): Map<string, Catalog> {
	const catalogs = new Map<string, Catalog>();
	for (const file of readdirSync(dataDirectory)
		.filter((name) => name.endsWith(".json"))
		.sort()) {
		catalogs.set(file, JSON.parse(readFileSync(`${dataDirectory}${file}`, "utf8")) as Catalog);
	}
	return catalogs;
}

function collectFamilyEntries(marker: FamilyId): FamilyEntry[] {
	return collectFamilyEntriesFrom(shippedCatalogs(), marker);
}

function offendersOf(entries: readonly FamilyEntry[], id: FamilyId): string[] {
	return entries
		.filter((entry) => entry.contextWindow !== EXPECTED[id].contextWindow)
		.map((entry) => `${entry.file}:${entry.api}/${entry.id}=${String(entry.contextWindow)}`)
		.sort();
}

describe("which catalog entries carry a GPT-6 tier's window", () => {
	const synthetic = (models: Record<string, number>): Map<string, Catalog> =>
		new Map([
			[
				"router.json",
				{
					"openai-completions": Object.fromEntries(
						Object.entries(models).map(([id, contextWindow]) => [id, { id, contextWindow }]),
					),
				},
			],
		]);

	it("Given a third-party router alias whose id contains the tier name when the catalogs are checked then it is not held to OpenAI's window", () => {
		const entries = collectFamilyEntriesFrom(
			synthetic({
				"chat:openai/gpt-6-luna": LUNA_CONTEXT_WINDOW,
				// The exact entry the release run regenerated from OpenRouter.
				"classifier:openai/gpt-6-luna-decisions": 1_050_000,
				"chat:typesafe-system-one/classifier:openai/gpt-6-luna-decisions": 1_050_000,
				"chat:openai/gpt-6-luna-decisions": 1_050_000,
				"chat:openrouter/openai/gpt-6-luna": 1_050_000,
				"chat:gpt-6-luna-mini": 1_050_000,
				// Same tier name, but not a chat row: the mode tag alone has to exclude these.
				"classifier:openai/gpt-6-luna": 1_050_000,
				"image:gpt-6-luna": 1_050_000,
			}),
			"gpt-6-luna",
		);
		expect(entries.map((entry) => entry.id)).toEqual(["chat:openai/gpt-6-luna"]);
		expect(offendersOf(entries, "gpt-6-luna")).toEqual([]);
	});

	it("Given an OpenAI tier model under any route's naming that misses the tier window when the catalogs are checked then it is reported", () => {
		const entries = collectFamilyEntriesFrom(
			synthetic({
				"chat:gpt-6-luna-fast": 1_050_000,
				"chat:openai/gpt-6-luna:batch": 1_050_000,
				"chat:global.openai.gpt-6-luna": 1_050_000,
				"chat:openai-gpt-6-luna": 1_050_000,
			}),
			"gpt-6-luna",
		);
		expect(offendersOf(entries, "gpt-6-luna")).toHaveLength(4);
	});
});

describe("GPT-6 Sol/6.1 Sol/Luna series catalog context window", () => {
	for (const id of FAMILY_IDS) {
		it(`declares ${EXPECTED[id].contextWindow} for every ${id} entry in every provider catalog`, () => {
			const entries = collectFamilyEntries(id);
			expect(entries.length, `generated catalogs should ship ${id} entries`).toBeGreaterThan(0);
			expect(offendersOf(entries, id), `${id} entries must all declare the tier context window`).toEqual([]);
		});

		it(`ships ${id} in the first-party OpenAI catalogs`, () => {
			const files = [...new Set(collectFamilyEntries(id).map((entry) => entry.file))];
			expect(files).toEqual(expect.arrayContaining(["openai.json", "chatgpt-subscription.json"]));
		});
	}
});
