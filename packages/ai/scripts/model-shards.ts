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
export const FORK_OWNED_MODEL_SHARDS: ReadonlySet<string> = new Set<string>(["devin.models.ts"]);

export const MODEL_SHARD_SUFFIX = ".models.ts";

export function isPrunableModelShard(entry: string, generatedShardFiles: ReadonlySet<string>): boolean {
	if (!entry.endsWith(MODEL_SHARD_SUFFIX)) return false;
	if (generatedShardFiles.has(entry)) return false;
	return !FORK_OWNED_MODEL_SHARDS.has(entry);
}
