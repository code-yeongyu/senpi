// senpi#2038
import { describe, expect, it } from "vitest";
import { type CursorCatalogEntry, normalizeCursorCatalog } from "../src/cursor/catalog-grouping.ts";
import { resolveCursorSelectionDescriptor } from "../src/cursor/selection-descriptor.ts";
import { regroupStoredCursorModels } from "../src/cursor/store-migration.ts";
import type { Model, ModelThinkingLevel } from "../src/types.ts";
import fixture from "./fixtures/cursor-usable-models-unlisted-20260923.json" with { type: "json" };

function rawEntry(id: string): { id: string; name: string; input: ("text" | "image")[]; cursorMaxMode: boolean } {
	return { id, name: id, input: ["text"], cursorMaxMode: false };
}

/** Derived maps are total: every unobserved level is explicitly unsupported (null). */
function levelMap(observed: Partial<Record<ModelThinkingLevel, string>>): Record<ModelThinkingLevel, string | null> {
	return { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null, ...observed };
}

function normalizedUnlisted(): CursorCatalogEntry[] {
	return normalizeCursorCatalog(
		fixture.models.map((entry) => ({
			id: entry.id,
			name: entry.name,
			input: entry.input as ("text" | "image")[],
			cursorMaxMode: entry.cursorMaxMode,
		})),
	);
}

function findDerived(id: string): CursorCatalogEntry {
	const entry = normalizedUnlisted().find((candidate) => candidate.id === id);
	expect(entry, `expected ${id} to be derived as a grouped identity`).toBeDefined();
	return entry as CursorCatalogEntry;
}

function entryToCursorModel(entry: CursorCatalogEntry): Model<"cursor-agent"> {
	return {
		id: entry.id,
		name: entry.name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: entry.reasoning,
		...(entry.thinkingLevelMap !== undefined ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
		input: [...entry.input],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.window,
		maxTokens: 64000,
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
	};
}

describe("normalizeCursorCatalog (derived variant grouping, senpi#2038)", () => {
	it("groups the five unlisted families into six reasoning identities", () => {
		const out = normalizedUnlisted();
		expect(out).toHaveLength(15);
		expect(out.filter((entry) => entry.reasoning)).toHaveLength(6);
		expect(out.filter((entry) => entry.reasoning).map((entry) => entry.id)).toEqual([
			"claude-fable-5-1",
			"claude-fable-5-1-thinking",
			"claude-opus-5-5",
			"gemini-3.8-flash",
			"grok-4.7",
			"muse-spark-1.3",
		]);
	});

	it("pins per-family thinkingLevelMap and variantIds", () => {
		const byId = new Map(normalizedUnlisted().map((entry) => [entry.id, entry]));

		const grok = byId.get("grok-4.7");
		expect(grok?.thinkingLevelMap).toEqual(levelMap({ low: "low", medium: "medium", high: "high", xhigh: "xhigh" }));
		expect(grok?.variantIds).toEqual({
			low: "grok-4.7-low",
			medium: "grok-4.7-medium",
			high: "grok-4.7-high",
			xhigh: "grok-4.7-xhigh",
		});

		const fablePlain = byId.get("claude-fable-5-1");
		expect(fablePlain?.thinkingMode).toBe(false);
		expect(fablePlain?.thinkingLevelMap).toEqual(
			levelMap({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }),
		);

		const fableThinking = byId.get("claude-fable-5-1-thinking");
		expect(fableThinking?.thinkingMode).toBe(true);
		expect(fableThinking?.thinkingLevelMap).toEqual(
			levelMap({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }),
		);
		expect(fableThinking?.variantIds?.xhigh).toBe("claude-fable-5-1-thinking-xhigh");
		expect(fableThinking?.variantIds?.max).toBe("claude-fable-5-1-thinking-max");

		const opus = byId.get("claude-opus-5-5");
		expect(opus?.thinkingLevelMap).toEqual(
			levelMap({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }),
		);
		expect(opus?.variantIds?.medium).toBe("claude-opus-5-5-medium");

		const gemini = byId.get("gemini-3.8-flash");
		expect(gemini?.thinkingLevelMap).toEqual(levelMap({ low: "low", medium: "medium", high: "high" }));
		expect(gemini?.variantIds).toEqual({
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
		});

		const muse = byId.get("muse-spark-1.3");
		expect(muse?.thinkingLevelMap).toEqual(
			levelMap({ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }),
		);
		expect(muse?.variantIds?.minimal).toBe("muse-spark-1.3-minimal");
	});

	it("derives identity metadata: display name, representative, legacyAliases, window, capabilityId", () => {
		const grok = findDerived("grok-4.7");
		expect(grok.name).toBe("Grok 4.7");
		expect(grok.representativeVariantId).toBe("grok-4.7-medium");
		expect(grok.legacyAliases).toEqual(["grok-4.7-high", "grok-4.7-low", "grok-4.7-medium", "grok-4.7-xhigh"]);
		expect(grok.capabilityId).toBe("grok-4.7");
		expect(grok.window).toBe(200000);
		expect(grok.thinkingMode).toBeUndefined();
		expect(grok.input).toEqual(["text"]);
	});

	it("keeps -fast variants flat singleton entries", () => {
		const out = normalizedUnlisted();
		const fastIds = out.map((entry) => entry.id).filter((id) => id.endsWith("-fast"));
		expect(fastIds).toHaveLength(9);
		for (const id of fastIds) {
			const entry = out.find((candidate) => candidate.id === id);
			expect(entry?.reasoning, id).toBe(false);
			expect(entry?.variantIds, id).toBeUndefined();
			expect(entry?.representativeVariantId, id).toBeUndefined();
			expect(entry?.legacyAliases, id).toEqual([id]);
		}
	});

	it("keeps a family with only one level and ids without a level token flat", () => {
		const out = normalizeCursorCatalog([rawEntry("solo-9-low"), rawEntry("unlisted-plain-model")]);
		expect(out).toHaveLength(2);
		for (const entry of out) {
			expect(entry.reasoning, entry.id).toBe(false);
			expect(entry.variantIds, entry.id).toBeUndefined();
			expect(entry.representativeVariantId, entry.id).toBeUndefined();
			expect(entry.legacyAliases, entry.id).toEqual([entry.id]);
		}
	});

	it("rejects derived families when a bare target id is listed", () => {
		const ids = ["grok-4.7", "grok-4.7-low", "grok-4.7-high"];
		const out = normalizeCursorCatalog(ids.map(rawEntry));
		expect(out.map((entry) => entry.id)).toEqual(ids);
		expect(out.every((entry) => !entry.reasoning && entry.variantIds === undefined)).toBe(true);
	});

	it("rejects a derived target claimed by a static alias even when that alias is not listed", () => {
		const ids = ["cursor-grok-4.6-none", "cursor-grok-4.6-minimal"];
		const out = normalizeCursorCatalog(ids.map(rawEntry));
		expect(out.map((entry) => entry.id)).toEqual(ids);
		expect(out.every((entry) => !entry.reasoning && entry.variantIds === undefined)).toBe(true);
	});

	it("does not add unlisted levels to a static group", () => {
		const ids = ["cursor-grok-4.6-high", "cursor-grok-4.6-none", "cursor-grok-4.6-minimal"];
		const out = normalizeCursorCatalog(ids.map(rawEntry));
		expect(out.map((entry) => entry.id)).toEqual(["cursor-grok-4.6", ...ids.slice(1)]);
		expect(out[0]?.representativeVariantId).toBe("cursor-grok-4.6-high");
		expect(out[0]?.legacyAliases).toEqual([ids[0]]);
		expect(out[0]?.variantIds).toBeUndefined();
		expect(out.slice(1).every((entry) => !entry.reasoning)).toBe(true);
	});

	it("keeps duplicate normalized levels flat and chooses xhigh regardless of listing order", () => {
		const ids = ["probe-low", "probe-extra-high", "probe-xhigh", "probe-xhigh-fast"];
		for (const listed of [ids, [...ids].reverse()]) {
			const out = normalizeCursorCatalog(listed.map(rawEntry));
			const group = out.find((entry) => entry.id === "probe");
			expect(group?.variantIds).toEqual({ low: "probe-low", xhigh: "probe-xhigh" });
			expect(group?.thinkingLevelMap).toEqual(levelMap({ low: "low", xhigh: "xhigh" }));
			expect(group?.legacyAliases).toEqual(["probe-low", "probe-xhigh"]);
			expect(out.find((entry) => entry.id === "probe-extra-high")?.reasoning).toBe(false);
			expect(out.find((entry) => entry.id === "probe-xhigh-fast")?.reasoning).toBe(false);
		}
	});

	it("uses the original parser base for derived capability and window; a static alias key target stays flat", () => {
		const out = normalizeCursorCatalog(
			["probe-high-low", "probe-high-medium", "gpt-5.5-high-low", "gpt-5.5-high-medium"].map(rawEntry),
		);
		expect(out.find((entry) => entry.id === "probe-high")).toMatchObject({
			capabilityId: "probe-high",
			window: 200000,
		});
		// `gpt-5.5-high` is a static alias key (of `gpt-5.5`); a derived identity must not shadow it.
		expect(out.some((entry) => entry.id === "gpt-5.5-high")).toBe(false);
		for (const id of ["gpt-5.5-high-low", "gpt-5.5-high-medium"]) {
			expect(out.find((entry) => entry.id === id)).toMatchObject({ reasoning: false, legacyAliases: [id] });
		}
	});

	it("yields static families next to derived ones byte-identically (no variantIds)", () => {
		const out = normalizeCursorCatalog([
			rawEntry("cursor-grok-4.6-high"),
			rawEntry("cursor-grok-4.6-medium"),
			rawEntry("cursor-grok-4.6-low"),
			rawEntry("cursor-grok-4.6-xhigh"),
			rawEntry("grok-4.7-low"),
			rawEntry("grok-4.7-medium"),
			rawEntry("grok-4.7-high"),
			rawEntry("grok-4.7-xhigh"),
		]);
		const staticGroup = out.find((entry) => entry.id === "cursor-grok-4.6");
		expect(staticGroup?.reasoning).toBe(true);
		expect(staticGroup?.variantIds).toBeUndefined();
		expect(staticGroup?.capabilityId).toBe("cursor-grok-4.6");
		expect(staticGroup?.window).toBe(500000);
		expect(staticGroup?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
		const derivedGroup = out.find((entry) => entry.id === "grok-4.7");
		expect(derivedGroup?.variantIds?.low).toBe("grok-4.7-low");
	});
});

describe("resolveCursorSelectionDescriptor on a derived grok-4.7 model", () => {
	function grokModel(): Model<"cursor-agent"> {
		return entryToCursorModel(findDerived("grok-4.7"));
	}

	it("maps every derived level to its exact server-listed variant id", () => {
		const model = grokModel();
		for (const level of ["low", "medium", "high", "xhigh"] as const satisfies readonly ModelThinkingLevel[]) {
			expect(resolveCursorSelectionDescriptor(model, { level, source: "explicit" })).toEqual({
				modelId: `grok-4.7-${level}`,
				parameters: [],
			});
		}
	});

	it("falls back to the representative for a level missing from variantIds", () => {
		const model = grokModel();
		for (const level of ["off", "minimal", "max"] as const satisfies readonly ModelThinkingLevel[]) {
			expect(resolveCursorSelectionDescriptor(model, { level, source: "explicit" })).toEqual({
				modelId: "grok-4.7-medium",
				parameters: [],
			});
		}
	});

	it("accepts derived member ids as legacy-variant selections and rejects unknown ones", () => {
		const model = grokModel();
		expect(
			resolveCursorSelectionDescriptor(model, {
				level: "xhigh",
				source: "legacy-variant",
				legacyVariantId: "grok-4.7-xhigh",
			}),
		).toEqual({ modelId: "grok-4.7-xhigh", parameters: [] });
		expect(
			resolveCursorSelectionDescriptor(model, {
				level: "low",
				source: "legacy-variant",
				legacyVariantId: "grok-4.7-turbo",
			}),
		).toEqual({ modelId: "grok-4.7-medium", parameters: [] });
	});
});

describe("regroupStoredCursorModels (derived families, senpi#2038)", () => {
	function storedFlat(id: string): Model<"cursor-agent"> {
		return {
			id,
			name: id,
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
			compat: {},
		};
	}

	function storedGrokBatch(): Model<"cursor-agent">[] {
		return ["grok-4.7-low", "grok-4.7-medium", "grok-4.7-high", "grok-4.7-xhigh"].map(storedFlat);
	}

	it("regroups stored flat grok-4.7 variants into one identity with variantIds", () => {
		const out = regroupStoredCursorModels(storedGrokBatch());
		expect(out).toHaveLength(1);
		const grok = out[0];
		expect(grok?.id).toBe("grok-4.7");
		expect(grok?.reasoning).toBe(true);
		expect(grok?.upstreamModelId).toBe("grok-4.7-medium");
		expect(grok?.thinkingLevelMap).toEqual(levelMap({ low: "low", medium: "medium", high: "high", xhigh: "xhigh" }));
		expect(grok?.compat?.cursorReasoning?.capabilityId).toBe("grok-4.7");
		expect(grok?.compat?.cursorReasoning?.representativeVariantId).toBe("grok-4.7-medium");
		expect(grok?.compat?.cursorReasoning?.variantIds).toEqual({
			low: "grok-4.7-low",
			medium: "grok-4.7-medium",
			high: "grok-4.7-high",
			xhigh: "grok-4.7-xhigh",
		});
	});

	it("coalesces a complete derived identity and flat members in either order at their first position", () => {
		const complete = entryToCursorModel(findDerived("grok-4.7"));
		const partial = {
			...complete,
			thinkingLevelMap: levelMap({ medium: "medium", xhigh: "xhigh" }),
			compat: {
				cursorReasoning: {
					capabilityId: "grok-4.7",
					representativeVariantId: "grok-4.7-medium",
					variantIds: {
						medium: "grok-4.7-medium",
						xhigh: "grok-4.7-xhigh",
					},
				},
			},
		};
		for (const existing of [partial, complete])
			for (const batch of [
				[existing, storedFlat("grok-4.7-low"), storedFlat("grok-4.7-high")],
				[storedFlat("grok-4.7-low"), storedFlat("grok-4.7-high"), existing],
			]) {
				const out = regroupStoredCursorModels([storedFlat("before"), ...batch, storedFlat("after")]);
				expect(out.map((model) => model.id)).toEqual(["before", "grok-4.7", "after"]);
				const grouped = out[1];
				expect(grouped?.compat?.cursorReasoning?.variantIds).toEqual({
					medium: "grok-4.7-medium",
					xhigh: "grok-4.7-xhigh",
					low: "grok-4.7-low",
					high: "grok-4.7-high",
				});
				expect(grouped?.thinkingLevelMap).toEqual(
					levelMap({ medium: "medium", xhigh: "xhigh", low: "low", high: "high" }),
				);
				expect(regroupStoredCursorModels(out)).toEqual(out);
			}
	});

	it("merges a single new flat level into an existing derived identity", () => {
		const complete = entryToCursorModel(findDerived("grok-4.7"));
		const out = regroupStoredCursorModels([storedFlat("grok-4.7-minimal"), complete]);
		expect(out.map((model) => model.id)).toEqual(["grok-4.7"]);
		expect(out[0]?.compat?.cursorReasoning?.variantIds?.minimal).toBe("grok-4.7-minimal");
		expect(regroupStoredCursorModels(out)).toEqual(out);
	});

	it("retains conflicting xhigh variants as flat models while merging only represented grok members", () => {
		const existing = entryToCursorModel(
			normalizeCursorCatalog(["grok-4.7-low", "grok-4.7-extra-high"].map(rawEntry))[0] as CursorCatalogEntry,
		);
		const batch = [
			existing,
			storedFlat("grok-4.7-xhigh"),
			storedFlat("grok-4.7-high"),
			storedFlat("grok-4.7-xhigh-fast"),
		];
		for (const listed of [batch, [...batch].reverse()]) {
			const out = regroupStoredCursorModels(listed);
			const ids = out.map((model) => model.id);
			expect(ids).toEqual(
				listed[0]?.id === "grok-4.7"
					? ["grok-4.7", "grok-4.7-xhigh", "grok-4.7-xhigh-fast"]
					: ["grok-4.7-xhigh-fast", "grok-4.7", "grok-4.7-xhigh"],
			);
			const group = out.find((model) => model.id === "grok-4.7") as Model<"cursor-agent">;
			expect(group.compat?.cursorReasoning?.variantIds).toEqual({
				low: "grok-4.7-low",
				xhigh: "grok-4.7-extra-high",
				high: "grok-4.7-high",
			});
			expect(resolveCursorSelectionDescriptor(group, { level: "xhigh", source: "explicit" })).toEqual({
				modelId: "grok-4.7-extra-high",
				parameters: [],
			});
			const flat = out.find((model) => model.id === "grok-4.7-xhigh") as Model<"cursor-agent">;
			expect(flat.reasoning).toBe(false);
			expect(resolveCursorSelectionDescriptor(flat, undefined)).toEqual({
				modelId: "grok-4.7-xhigh",
				parameters: [],
			});
			expect(regroupStoredCursorModels(out)).toEqual(out);
		}
	});

	it("coalesces the thinking identity even when every incoming level conflicts", () => {
		const existing = entryToCursorModel(
			normalizeCursorCatalog(
				["claude-fable-5-1-thinking-low", "claude-fable-5-1-thinking-high"].map(rawEntry),
			)[0] as CursorCatalogEntry,
		);
		const batch = [
			existing,
			storedFlat("claude-fable-5-1-low-thinking"),
			storedFlat("claude-fable-5-1-high-thinking"),
		];
		for (const listed of [batch, [...batch].reverse()]) {
			const out = regroupStoredCursorModels(listed);
			expect(out.map((model) => model.id)).toEqual(
				listed[0]?.id === "claude-fable-5-1-thinking"
					? ["claude-fable-5-1-thinking", "claude-fable-5-1-low-thinking", "claude-fable-5-1-high-thinking"]
					: ["claude-fable-5-1-high-thinking", "claude-fable-5-1-low-thinking", "claude-fable-5-1-thinking"],
			);
			const group = out.find((model) => model.id === "claude-fable-5-1-thinking") as Model<"cursor-agent">;
			expect(group.compat?.cursorReasoning?.variantIds).toEqual({
				low: "claude-fable-5-1-thinking-low",
				high: "claude-fable-5-1-thinking-high",
			});
			expect(resolveCursorSelectionDescriptor(group, { level: "low", source: "explicit" })).toEqual({
				modelId: "claude-fable-5-1-thinking-low",
				parameters: [],
			});
			for (const id of ["claude-fable-5-1-low-thinking", "claude-fable-5-1-high-thinking"]) {
				const flat = out.find((model) => model.id === id) as Model<"cursor-agent">;
				expect(flat.reasoning).toBe(false);
				expect(resolveCursorSelectionDescriptor(flat, undefined)).toEqual({ modelId: id, parameters: [] });
			}
			expect(regroupStoredCursorModels(out)).toEqual(out);
		}
	});

	it("coalesces duplicate conflicting flat ids without consuming them into the retained group", () => {
		const existing = entryToCursorModel(
			normalizeCursorCatalog(["grok-4.7-low", "grok-4.7-extra-high"].map(rawEntry))[0] as CursorCatalogEntry,
		);
		const conflicting = storedFlat("grok-4.7-xhigh");
		const out = regroupStoredCursorModels([existing, conflicting, { ...conflicting, name: "duplicate" }]);
		expect(out.map((model) => model.id)).toEqual(["grok-4.7", "grok-4.7-xhigh"]);
		expect(out[1]).toEqual(conflicting);
		expect(regroupStoredCursorModels(out)).toEqual(out);
	});

	it("coalesces duplicate stored derived identities without any flat entries or new metadata", () => {
		const existing = entryToCursorModel(findDerived("grok-4.7"));
		const duplicate = { ...existing, name: "second copy" };
		for (const listed of [
			[storedFlat("before"), existing, storedFlat("between"), duplicate, storedFlat("after")],
			[storedFlat("before"), duplicate, storedFlat("between"), existing, storedFlat("after")],
		]) {
			const out = regroupStoredCursorModels(listed);
			expect(out.map((model) => model.id)).toEqual(["before", "grok-4.7", "between", "after"]);
			expect(out[1]).toEqual(listed[1]);
			expect(regroupStoredCursorModels(out)).toEqual(out);
		}
	});

	it("is idempotent on its own output", () => {
		const once = regroupStoredCursorModels(storedGrokBatch());
		const twice = regroupStoredCursorModels(once);
		expect(twice.map((model) => JSON.stringify(model))).toEqual(once.map((model) => JSON.stringify(model)));
	});

	it("keeps unknown flat entries in stable order beside the derived identity", () => {
		const out = regroupStoredCursorModels([
			storedFlat("zzz-custom-thing"),
			...storedGrokBatch(),
			storedFlat("grok-4.7-high-fast"),
		]);
		expect(out.map((model) => model.id)).toEqual(["zzz-custom-thing", "grok-4.7", "grok-4.7-high-fast"]);
	});
});
