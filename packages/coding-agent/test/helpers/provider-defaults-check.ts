/**
 * The release's provider-defaults check (`check:provider-defaults` runs the "default model selection" tests in
 * model-resolver.test.ts). Both the real-catalog test and the deprecated-default fixture test call this, so the
 * fixture exercises the exact rule the release applies.
 */
export const providersMissingDefault = (
	defaults: Record<string, string>,
	catalogIds: (provider: string) => readonly string[],
): string[] => {
	const missing: string[] = [];
	for (const [provider, defaultModelId] of Object.entries(defaults)) {
		// radius/ollama are dynamic catalogs; cursor is authentication-only until
		// its chat protocol is ported.
		if (provider === "radius" || provider === "ollama" || provider === "cursor") continue;
		const ids = catalogIds(provider);
		if (!ids.includes(defaultModelId))
			missing.push(`${provider}: ${defaultModelId} (catalog has ${ids.length} models)`);
	}
	return missing;
};
