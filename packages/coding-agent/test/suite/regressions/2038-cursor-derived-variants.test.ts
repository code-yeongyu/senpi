// senpi#2038
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeCursorCatalog } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	parseModelPattern,
	resolveModelScopeFromModels,
	resolveStoredModelReference,
} from "../../../src/core/model-resolver.ts";

interface FixtureModel {
	readonly id: string;
	readonly name: string;
	readonly input: readonly ("text" | "image")[];
	readonly cursorMaxMode: boolean;
}

const FIXTURE_PATH = fileURLToPath(
	new URL("../../../../ai/test/fixtures/cursor-usable-models-unlisted-20260923.json", import.meta.url),
);

/** Maps the unlisted-ids fixture the way `packages/ai/src/providers/cursor.ts` maps its catalog. */
function fixtureCursorModels(): Model<"cursor-agent">[] {
	const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { models: FixtureModel[] };
	const normalized = normalizeCursorCatalog(
		fixture.models.map((model) => ({
			id: model.id,
			name: model.name,
			input: model.input,
			cursorMaxMode: model.cursorMaxMode,
		})),
	);
	return normalized.map(
		(entry): Model<"cursor-agent"> => ({
			id: entry.id,
			name: entry.name,
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: entry.reasoning,
			...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
			input: [...entry.input],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.window,
			maxTokens: 64_000,
			...(entry.representativeVariantId !== undefined && entry.representativeVariantId !== entry.id
				? { upstreamModelId: entry.representativeVariantId }
				: {}),
			compat: {
				...(entry.capabilityId !== undefined && entry.representativeVariantId !== undefined
					? {
							cursorReasoning: {
								capabilityId: entry.capabilityId,
								...(entry.thinkingMode !== undefined ? { thinkingMode: entry.thinkingMode } : {}),
								representativeVariantId: entry.representativeVariantId,
								...(entry.variantIds !== undefined ? { variantIds: entry.variantIds } : {}),
							},
						}
					: {}),
			},
		}),
	);
}

describe("senpi#2038: derived Cursor variant groups resolve in the model resolver", () => {
	const cursorModels = fixtureCursorModels();
	const cliModels: Model<Api>[] = cursorModels.map((model) => ({
		...model,
		api: "cursor-cli-oauth" as const,
		provider: "cursor-cli-oauth",
	}));
	const models: Model<Api>[] = [...cursorModels];

	test("the fixture maps to a derived grok-4.7 identity carrying variant ids", () => {
		const grok = cursorModels.find((model) => model.id === "grok-4.7");
		expect(grok).toBeDefined();
		expect(grok?.reasoning).toBe(true);
		expect(grok?.compat?.cursorReasoning?.variantIds).toEqual({
			low: "grok-4.7-low",
			medium: "grok-4.7-medium",
			high: "grok-4.7-high",
			xhigh: "grok-4.7-xhigh",
		});
	});

	test("cursor/grok-4.7-xhigh resolves as a legacy variant of the derived identity", () => {
		const result = parseModelPattern("cursor/grok-4.7-xhigh", models);
		expect(result.model?.provider).toBe("cursor");
		expect(result.model?.id).toBe("grok-4.7");
		expect(result.thinkingLevel).toBe("xhigh");
		expect(result.thinkingSelection).toEqual({
			level: "xhigh",
			source: "legacy-variant",
			legacyVariantId: "grok-4.7-xhigh",
		});
	});

	test("the registered CLI lane resolves a legacy variant, stored reference, and glob projection", () => {
		const resolved = parseModelPattern("cursor-cli-oauth/grok-4.7-xhigh", cliModels);
		expect(resolved.model?.id).toBe("grok-4.7");
		expect(resolved.thinkingSelection).toEqual({
			level: "xhigh",
			source: "legacy-variant",
			legacyVariantId: "grok-4.7-xhigh",
		});
		const stored = resolveStoredModelReference("cursor-cli-oauth", "grok-4.7-xhigh", {
			getModel: (provider, id) => cliModels.find((model) => model.provider === provider && model.id === id),
		});
		expect(stored?.model.id).toBe("grok-4.7");
		expect(stored?.thinkingSelection).toEqual(resolved.thinkingSelection);
		const { scopedModels, diagnostics } = resolveModelScopeFromModels(
			["cursor-cli-oauth/grok-4.7-xhigh*"],
			cliModels,
		);
		expect(diagnostics).toEqual([]);
		expect(scopedModels.map((entry) => entry.model.id)).toEqual(["grok-4.7", "grok-4.7-xhigh-fast"]);
	});

	test("a unique exact raw model wins over derived reverse lookup for both Cursor lanes", () => {
		for (const [provider, catalog] of [
			["cursor", models],
			["cursor-cli-oauth", cliModels],
		] as const) {
			const exact = { ...catalog[0], id: "grok-4.7-xhigh", provider };
			const available = [...catalog, exact];
			expect(parseModelPattern(`${provider}/grok-4.7-xhigh`, available).model).toBe(exact);
			expect(parseModelPattern(`${provider}/grok-4.7-xhigh`, available).thinkingSelection).toBeUndefined();
			expect(
				resolveStoredModelReference(provider, exact.id, {
					getModel: (candidateProvider, id) =>
						available.find((model) => model.provider === candidateProvider && model.id === id),
				})?.model,
			).toBe(exact);
		}
	});

	test("an unqualified exact id on another provider wins over derived Cursor lookup", () => {
		const exact = { ...cursorModels[0], provider: "other", id: "grok-4.7-xhigh" };
		const resolved = parseModelPattern(exact.id, [...models, exact]);
		expect(resolved.model).toBe(exact);
		expect(resolved.thinkingSelection).toBeUndefined();
	});

	test("cursor/grok-4.7:xhigh resolves to grok-4.7 with an explicit xhigh selection", () => {
		const result = parseModelPattern("cursor/grok-4.7:xhigh", models);
		expect(result.model?.id).toBe("grok-4.7");
		expect(result.thinkingLevel).toBe("xhigh");
		expect(result.thinkingSelection).toEqual({ level: "xhigh", source: "explicit" });
	});

	test("cursor/grok-4.7:low resolves to grok-4.7 low, not the flat fast variant", () => {
		const result = parseModelPattern("cursor/grok-4.7:low", models);
		expect(result.model?.id).toBe("grok-4.7");
		expect(result.thinkingLevel).toBe("low");
		expect(result.model?.id).not.toBe("grok-4.7-xhigh-fast");
	});

	test("resolveStoredModelReference maps a stored variant id onto the derived identity", () => {
		const source = {
			getModel: (provider: string, modelId: string) =>
				models.find((model) => model.provider === provider && model.id === modelId),
		};
		const resolved = resolveStoredModelReference("cursor", "grok-4.7-medium", source);
		expect(resolved?.model.id).toBe("grok-4.7");
		expect(resolved?.thinkingLevel).toBe("medium");
		expect(resolved?.thinkingSelection).toEqual({
			level: "medium",
			source: "legacy-variant",
			legacyVariantId: "grok-4.7-medium",
		});
	});

	test("cursor/grok-4.7-xhigh-fast still resolves to the flat fast model", () => {
		const result = parseModelPattern("cursor/grok-4.7-xhigh-fast", models);
		expect(result.model?.id).toBe("grok-4.7-xhigh-fast");
		expect(result.model?.reasoning).toBe(false);
		expect(result.thinkingSelection).toBeUndefined();
	});

	test("glob cursor/grok-4.7-* projects the derived identity plus the fast models", () => {
		const { scopedModels, diagnostics } = resolveModelScopeFromModels(["cursor/grok-4.7-*"], models);
		expect(diagnostics).toEqual([]);
		const ids = scopedModels.map((scoped) => scoped.model.id).sort();
		expect(ids).toEqual(
			["grok-4.7", "grok-4.7-high-fast", "grok-4.7-low-fast", "grok-4.7-medium-fast", "grok-4.7-xhigh-fast"].sort(),
		);
	});
});
