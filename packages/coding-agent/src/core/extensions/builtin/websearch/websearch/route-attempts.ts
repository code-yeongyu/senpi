import type { SearchProviderEntry } from "./types.ts";

interface RouteLabelSource {
	readonly provider: string;
	readonly id?: string;
	readonly entryId?: string;
	readonly model?: string;
}

export function providerEntryLabel(entry: RouteLabelSource): string {
	const id = entry.entryId ?? entry.id;
	if (!id || id === entry.provider) return entry.provider;
	const nativePrefix = `native-${entry.provider}-`;
	return id.endsWith("/native") ? id : `${entry.provider}/${id.startsWith(nativePrefix) ? "native" : id}`;
}

export function attemptRouteLabel(entry: RouteLabelSource): string {
	const label = providerEntryLabel(entry);
	return entry.model ? `${label} (${entry.model})` : label;
}

export function routeAttemptEntries(entry: SearchProviderEntry): [SearchProviderEntry, ...SearchProviderEntry[]] {
	const { fallbackModel, ...primary } = entry;
	if (!fallbackModel || fallbackModel === primary.model) return [primary];
	return [primary, { ...primary, model: fallbackModel }];
}
