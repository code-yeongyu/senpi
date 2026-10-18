/**
 * Ownership rules for the per-provider `*.models.ts` catalog shards.
 *
 * The generator writes one shard per models.dev provider and prunes every other
 * shard so a provider dropped upstream cannot linger. A fork provider that
 * models.dev does not describe owns its shard by hand, and pruning it breaks the
 * provider module that imports it - a failure only the release job sees, because
 * ordinary CI type-checks against the committed catalog instead of regenerating
 * it. Such shards are listed here and left alone.
 */
export const FORK_OWNED_MODEL_SHARDS: ReadonlySet<string> = new Set<string>(["devin.models.ts", "kimi-coding.models.ts"]);

/** `kimi-coding.models.ts` -> `kimi-coding`. */
export function providerIdOfShard(entry: string): string {
	return entry.slice(0, -MODEL_SHARD_SUFFIX.length);
}

export const MODEL_SHARD_SUFFIX = ".models.ts";

/**
 * @param importedShards shards a committed provider module imports. A shard nothing generated is
 * still load-bearing while `src/providers/<id>.ts` imports it, and pruning it leaves a tree that
 * only fails at the release job's type-check. The allowlist above stays for shards with no module.
 */
export function isPrunableModelShard(
	entry: string,
	generatedShardFiles: ReadonlySet<string>,
	importedShards: ReadonlySet<string> = new Set(),
): boolean {
	if (!entry.endsWith(MODEL_SHARD_SUFFIX)) return false;
	if (generatedShardFiles.has(entry)) return false;
	if (importedShards.has(entry)) return false;
	return !FORK_OWNED_MODEL_SHARDS.has(entry);
}

/** The shards imported by the provider modules committed beside them. */
export function importedModelShards(providerModuleSources: Iterable<string>): ReadonlySet<string> {
	const imported = new Set<string>();
	for (const source of providerModuleSources) {
		for (const match of source.matchAll(/from "\.\/([A-Za-z0-9._-]+\.models\.ts)"/g)) {
			const shard = match[1];
			if (shard !== undefined) imported.add(shard);
		}
	}
	return imported;
}
