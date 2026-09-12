import type { Model } from "@earendil-works/pi-ai";
import type { PatternResolution } from "../../../core/model-resolver.ts";

export type FavoriteModelIds = string[] | null;

export function getModelFullId(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

export function isFavoriteModel(favoriteIds: FavoriteModelIds, id: string): boolean {
	return favoriteIds === null || favoriteIds.includes(id);
}

export function toggleFavoriteModel(favoriteIds: FavoriteModelIds, allIds: string[], id: string): FavoriteModelIds {
	if (favoriteIds === null) {
		return allIds.filter((candidateId) => candidateId !== id);
	}
	const index = favoriteIds.indexOf(id);
	if (index >= 0) return [...favoriteIds.slice(0, index), ...favoriteIds.slice(index + 1)];
	return [...favoriteIds, id];
}

export function favoriteModels(
	favoriteIds: FavoriteModelIds,
	allIds: string[],
	targetIds?: string[],
): FavoriteModelIds {
	if (favoriteIds === null) return null;
	const targets = targetIds ?? allIds;
	const result = [...favoriteIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return result.length === allIds.length ? null : result;
}

export function clearFavoriteModels(
	favoriteIds: FavoriteModelIds,
	allIds: string[],
	targetIds?: string[],
): FavoriteModelIds {
	if (favoriteIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? favoriteIds);
	return favoriteIds.filter((id) => !targets.has(id));
}

export function moveFavoriteModel(favoriteIds: FavoriteModelIds, id: string, delta: number): FavoriteModelIds {
	if (favoriteIds === null) return null;
	const index = favoriteIds.indexOf(id);
	if (index < 0) return [...favoriteIds];
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= favoriteIds.length) return [...favoriteIds];
	const result = [...favoriteIds];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

export function mergeFavoritePatternsForPersist(options: {
	storedPatterns: readonly string[];
	patternResolutions: readonly PatternResolution[];
	selectedIds: FavoriteModelIds;
	candidateIds: readonly string[];
}): string[] | undefined {
	const { storedPatterns, patternResolutions, selectedIds, candidateIds } = options;
	const selected = selectedIds === null ? [...candidateIds] : selectedIds;
	const selectedSet = new Set(selected);
	const candidateSet = new Set(candidateIds);
	const accountedIds = new Set<string>();
	const merged: string[] = [];
	const mergedSet = new Set<string>();

	const append = (pattern: string): void => {
		if (mergedSet.has(pattern)) return;
		mergedSet.add(pattern);
		merged.push(pattern);
	};
	const decorateExactId = (id: string, resolution: PatternResolution): string => {
		let exactPattern = id;
		if (resolution.serviceTier) exactPattern += `:${resolution.serviceTier}`;
		if (resolution.thinkingLevel) exactPattern += `:${resolution.thinkingLevel}`;
		return exactPattern;
	};

	// Resolutions are matched by pattern identity, not position: the stored list can
	// drift from the snapshot (settings edited between capture and merge), and a
	// positional mismatch used to drop the pattern into the bare-id append path,
	// silently losing its `:level`/`:tier` decorators. Duplicate stored patterns share
	// the first (owning) resolution; the later duplicate resolves to no ownership
	// anyway, and identical merged strings are deduped by `append`.
	const resolutionByPattern = new Map<string, PatternResolution>();
	for (const resolution of patternResolutions) {
		if (!resolutionByPattern.has(resolution.pattern)) resolutionByPattern.set(resolution.pattern, resolution);
	}

	for (const storedPattern of storedPatterns) {
		const resolution = resolutionByPattern.get(storedPattern);
		if (!resolution) continue;

		if (resolution.unresolved) {
			append(resolution.pattern);
			continue;
		}

		// A resolved pattern with no ownership only duplicated models claimed by an
		// earlier pattern. Keeping it could resurrect a model the user just removed.
		if (resolution.ownedIds.length === 0) continue;

		const visibleOwnedIds = resolution.ownedIds.filter((id) => candidateSet.has(id));
		const selectedVisibleIds = visibleOwnedIds.filter((id) => selectedSet.has(id));
		const selectedPositions = selectedVisibleIds.map((id) => selected.indexOf(id));
		const remainsOrderedBlock = selectedPositions.every(
			(position, positionIndex) => positionIndex === 0 || position === selectedPositions[positionIndex - 1] + 1,
		);
		const preserveVerbatim = selectedVisibleIds.length === visibleOwnedIds.length && remainsOrderedBlock;

		if (preserveVerbatim) {
			append(resolution.pattern);
			for (const id of selectedVisibleIds) accountedIds.add(id);
			continue;
		}

		if (!resolution.isGlob) continue;

		// An edited glob becomes exact entries. Visible entries follow the selector
		// order; registry-owned entries outside the candidate set must survive too.
		const selectedVisibleSet = new Set(selectedVisibleIds);
		const explodedIds = [
			...selected.filter((id) => selectedVisibleSet.has(id)),
			...resolution.ownedIds.filter((id) => !candidateSet.has(id)),
		];
		for (const id of explodedIds) {
			append(decorateExactId(id, resolution));
			if (candidateSet.has(id)) accountedIds.add(id);
		}
	}

	for (const id of selected) {
		if (!accountedIds.has(id)) append(id);
	}
	return merged.length > 0 ? merged : undefined;
}

export function getSortedFavoriteModelIds(favoriteIds: FavoriteModelIds, allIds: string[]): string[] {
	if (favoriteIds === null) return allIds;
	const favoriteSet = new Set(favoriteIds);
	return [...favoriteIds, ...allIds.filter((id) => !favoriteSet.has(id))];
}
