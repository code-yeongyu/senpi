import type { Model, ModelThinkingLevel } from "../types.ts";
import { type CursorCatalogEntry, deriveCursorVariantAliases, normalizeCursorCatalog } from "./catalog-grouping.ts";
import { resolveCursorContextWindow } from "./context-limit-store.ts";
import { getCursorVariantAlias, parseCursorVariantId } from "./model-capabilities.ts";

/**
 * Fill levels a stored static group lacks from flat alias rows regrouped beside it;
 * the group's own levels, representative, and compat metadata are never replaced.
 */
function absorbStaticLevels(
	current: Model<"cursor-agent">,
	flatGroup: Model<"cursor-agent"> | undefined,
): Model<"cursor-agent"> {
	const additions = Object.entries(flatGroup?.thinkingLevelMap ?? {}).filter(
		([level, value]) => value != null && current.thinkingLevelMap?.[level as ModelThinkingLevel] == null,
	);
	if (additions.length === 0) return current;
	return { ...current, thinkingLevelMap: { ...current.thinkingLevelMap, ...Object.fromEntries(additions) } };
}

function entryToModel(entry: CursorCatalogEntry, maxTokensById: ReadonlyMap<string, number>): Model<"cursor-agent"> {
	const representative = entry.representativeVariantId ?? entry.legacyAliases[0] ?? entry.id;
	const maxTokens = maxTokensById.get(representative) ?? maxTokensById.get(entry.id) ?? 64000;
	return {
		id: entry.id,
		name: entry.name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: entry.reasoning,
		...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
		input: entry.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: resolveCursorContextWindow(entry.id, entry.window),
		maxTokens,
		...(entry.representativeVariantId !== undefined && entry.representativeVariantId !== entry.id
			? { upstreamModelId: entry.representativeVariantId }
			: {}),
		compat: {
			...(entry.cursorMaxMode ? { cursorMaxMode: true } : {}),
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

/**
 * Idempotent stored-catalog transform: pre-grouping 204-variant cursor entries
 * are regrouped into selectable identities, including families the static
 * alias table does not list yet, which are derived over the stored batch
 * (senpi#2038). An already-grouped identity (static or derived) always wins
 * over flat rows aliasing it, regardless of input order, and absorbs their
 * levels without losing its own metadata; conflicting derived variants stay
 * flat, and duplicate identities coalesce at their first position in stable
 * input order.
 */
export function regroupStoredCursorModels(models: readonly Model<"cursor-agent">[]): Model<"cursor-agent">[] {
	const existingGroups = new Map<string, Model<"cursor-agent">>();
	const existingDerived = new Map<string, Model<"cursor-agent">>();
	const representedTargetById = new Map<string, string>();
	for (const model of models) {
		const reasoning = model.compat?.cursorReasoning;
		if (reasoning === undefined || existingGroups.has(model.id)) continue;
		existingGroups.set(model.id, model);
		if (reasoning.variantIds === undefined) continue;
		existingDerived.set(model.id, model);
		for (const id of Object.values(reasoning.variantIds)) representedTargetById.set(id, model.id);
	}
	const derived = deriveCursorVariantAliases([
		...models.filter((model) => model.compat?.cursorReasoning === undefined).map((model) => model.id),
		...[...existingDerived.values()].flatMap((model) =>
			Object.values(model.compat?.cursorReasoning?.variantIds ?? {}),
		),
	]);
	const isLegacy = (model: Model<"cursor-agent">): boolean =>
		model.compat?.cursorReasoning === undefined &&
		(getCursorVariantAlias(model.id) !== undefined || derived.has(model.id) || representedTargetById.has(model.id));
	const legacy = models.filter(isLegacy);
	const maxTokensById = new Map(models.map((model) => [model.id, model.maxTokens]));
	const regrouped = new Map(
		normalizeCursorCatalog(
			legacy.map((model) => ({
				id: model.id,
				name: model.name,
				input: model.input.filter((modality): modality is "text" | "image" => modality !== "video"),
				cursorMaxMode: model.compat?.cursorMaxMode === true,
			})),
		).map((entry) => [entry.id, entryToModel(entry, maxTokensById)] as const),
	);
	const merged = new Map<string, Model<"cursor-agent">>();
	for (const [targetId, current] of existingGroups) {
		const kept = current.compat?.cursorReasoning;
		if (kept?.variantIds === undefined) {
			merged.set(targetId, absorbStaticLevels(current, regrouped.get(targetId)));
			continue;
		}
		const variantIds = { ...kept.variantIds };
		const thinkingLevelMap = { ...current.thinkingLevelMap };
		let changed = false;
		for (const model of legacy) {
			const alias = derived.get(model.id);
			if (alias?.targetId !== targetId || alias.level === undefined) continue;
			if (variantIds[alias.level] !== undefined && variantIds[alias.level] !== model.id) continue;
			variantIds[alias.level] = model.id;
			thinkingLevelMap[alias.level] = parseCursorVariantId(model.id).level;
			changed = true;
		}
		merged.set(
			targetId,
			changed
				? {
						...current,
						thinkingLevelMap,
						compat: { ...current.compat, cursorReasoning: { ...kept, variantIds } },
					}
				: current,
		);
	}
	const seen = new Set<string>();
	const out: Model<"cursor-agent">[] = [];
	for (const model of models) {
		const alias = isLegacy(model) ? (getCursorVariantAlias(model.id) ?? derived.get(model.id)) : undefined;
		const targetId =
			alias?.targetId ?? (isLegacy(model) ? representedTargetById.get(model.id) : undefined) ?? model.id;
		const coalesced = merged.get(targetId);
		if (coalesced !== undefined) {
			const retainedIds = coalesced.compat?.cursorReasoning?.variantIds;
			// Static groups absorb every flat alias row; derived groups keep conflicting variants flat.
			const absorbed =
				model.id === targetId ||
				(retainedIds === undefined ? isLegacy(model) : Object.values(retainedIds).includes(model.id));
			if (!absorbed) {
				if (!seen.has(model.id)) out.push(model);
				seen.add(model.id);
				continue;
			}
			if (!seen.has(targetId)) out.push(coalesced);
			seen.add(targetId);
			continue;
		}
		if (!isLegacy(model)) {
			if (!seen.has(model.id)) out.push(model);
			seen.add(model.id);
			continue;
		}
		if (seen.has(targetId)) continue;
		seen.add(targetId);
		out.push(regrouped.get(targetId) ?? model);
	}
	return out;
}
