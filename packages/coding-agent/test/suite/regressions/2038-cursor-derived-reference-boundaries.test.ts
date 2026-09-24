// senpi#2038
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeCursorCatalog, resolveCursorSelectionDescriptor } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { parseCursorAgentModelsListing } from "../../../src/core/extensions/builtin/cursor-cli-oauth/models.ts";
import { parseModelPattern, resolveStoredModelReference } from "../../../src/core/model-resolver.ts";

/** Maps raw ids the way `packages/ai/src/providers/cursor.ts` maps its live catalog. */
function nativeModels(ids: readonly string[]): Model<Api>[] {
	return normalizeCursorCatalog(ids.map((id) => ({ id, name: id, input: ["text"], cursorMaxMode: false }))).map(
		(entry): Model<"cursor-agent"> => ({
			id: entry.id,
			name: entry.name,
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: entry.reasoning,
			...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.window,
			maxTokens: 64_000,
			compat:
				entry.capabilityId !== undefined && entry.representativeVariantId !== undefined
					? {
							cursorReasoning: {
								capabilityId: entry.capabilityId,
								representativeVariantId: entry.representativeVariantId,
								...(entry.variantIds !== undefined ? { variantIds: entry.variantIds } : {}),
							},
						}
					: {},
		}),
	);
}

function cliModels(ids: readonly string[]): Model<Api>[] {
	return parseCursorAgentModelsListing(ids.map((id) => `${id} - ${id}`).join("\n")).map(
		(model): Model<Api> => ({ ...model, api: "cursor-cli-oauth", provider: "cursor-cli-oauth", baseUrl: "cli" }),
	);
}

const lanes = [
	{ provider: "cursor", build: nativeModels },
	{ provider: "cursor-cli-oauth", build: cliModels },
] as const;

const GROK_IDS = ["grok-4.7-low", "grok-4.7-medium", "grok-4.7-high", "grok-4.7-xhigh", "grok-4.7-xhigh-fast"];

describe("senpi#2038: derived Cursor references keep exact-match semantics", () => {
	for (const { provider, build } of lanes) {
		test(`${provider}: a mixed-case legacy variant resolves to the derived level, not the -fast model`, () => {
			const models = build(GROK_IDS);
			for (const reference of [
				"GROK-4.7-XHIGH",
				`${provider}/GROK-4.7-XHIGH`,
				`${provider.toUpperCase()}/Grok-4.7-XHigh`,
			]) {
				const parsed = parseModelPattern(reference, models);
				expect(parsed.model?.id, reference).toBe("grok-4.7");
				expect(parsed.thinkingLevel, reference).toBe("xhigh");
				// The catalog spelling is forwarded because the wire allowlist is exact.
				expect(parsed.thinkingSelection, reference).toEqual({
					level: "xhigh",
					source: "legacy-variant",
					legacyVariantId: "grok-4.7-xhigh",
				});
				expect(
					resolveCursorSelectionDescriptor(parsed.model as Model<"cursor-agent">, parsed.thinkingSelection)
						.modelId,
				).toBe("grok-4.7-xhigh");
			}
		});

		test(`${provider}: a derived family never shadows a static alias key`, () => {
			const models = build(["gpt-5.5-low", "gpt-5.5-medium", "gpt-5.5-high-low", "gpt-5.5-high-medium"]);
			expect(models.map((model) => `${model.id}:${model.reasoning}`)).toEqual([
				"gpt-5.5:true",
				"gpt-5.5-high-low:false",
				"gpt-5.5-high-medium:false",
			]);
			const expected = {
				level: "high",
				source: "legacy-variant",
				legacyVariantId: "gpt-5.5-high",
			} as const;
			const parsed = parseModelPattern(`${provider}/gpt-5.5-high`, models);
			expect(parsed.model?.id).toBe("gpt-5.5");
			expect(parsed.thinkingSelection).toEqual(expected);
			const stored = resolveStoredModelReference(provider, "gpt-5.5-high", {
				getModel: (candidateProvider, id) =>
					models.find((model) => model.provider === candidateProvider && model.id === id),
			});
			expect(stored?.model.id).toBe("gpt-5.5");
			expect(stored?.thinkingSelection).toEqual(expected);
			expect(parseModelPattern(`${provider}/gpt-5.5-high-low`, models).model?.id).toBe("gpt-5.5-high-low");
		});
	}
});
