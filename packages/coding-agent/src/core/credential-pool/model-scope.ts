/**
 * Model-scoped rate limits (senpi#2555). An Anthropic subscription rejects a
 * request with the unified rate-limit headers, and their representative claim
 * names the exceeded window: `five_hour` and `seven_day` bind the account,
 * while `seven_day_opus`, `seven_day_sonnet` and `seven_day_overage_included`
 * bind one model family. Claude Code renders that claim into the failure text
 * ("session limit", "weekly limit", "Opus limit", "Sonnet limit", "Fable
 * limit"), so the family name in the limit phrase is the model-scope signal.
 * An account-wide window never names a model; everything without a family
 * stays account-wide.
 */

const FAMILY_KEY = /^(?:opus|sonnet|haiku|fable|mythos)$/;
const MODEL_FAMILY_LIMIT =
	/\b(opus|sonnet|haiku|fable|mythos)(?:\s+\d+(?:\.\d+)?)?(?:\s+(?:weekly|daily|monthly|session|\d+-hour))?\s+limit\b/i;

/** A model block's expiry, keyed by model family (`fable`) or, failing that, the exact model id. */
export type ModelBlocks = Readonly<Record<string, { readonly blockedUntil: number }>>;

export function rateLimitModelFamily(text: string): string | undefined {
	return MODEL_FAMILY_LIMIT.exec(text)?.[1]?.toLowerCase();
}

function inFamily(modelId: string, family: string): boolean {
	return new RegExp(`(?:^|[^a-z])${family}(?:[^a-z]|$)`, "i").test(modelId);
}

/**
 * Where a model-scoped block is recorded: the family when the requested model
 * belongs to it (one limit covers every Fable model), otherwise the exact model
 * id, so a block never leaks onto a model the response did not name.
 */
export function modelBlockKey(family: string, modelId: string): string {
	return inFamily(modelId, family) ? family : modelId;
}

function applies(key: string, modelId: string): boolean {
	return key === modelId || (FAMILY_KEY.test(key) && inFamily(modelId, key));
}

/** The latest live expiry among the blocks that bind `modelId`, or undefined when it is free. */
export function activeModelBlockUntil(
	blocks: ModelBlocks | undefined,
	modelId: string | undefined,
	now: number,
): number | undefined {
	if (blocks === undefined || modelId === undefined) return undefined;
	let until: number | undefined;
	for (const [key, block] of Object.entries(blocks)) {
		if (block.blockedUntil > now && applies(key, modelId) && (until === undefined || block.blockedUntil > until)) {
			until = block.blockedUntil;
		}
	}
	return until;
}

/**
 * Drops expired entries and, when `servedModelId` is given, the entries that
 * bind it (a model that just served is not limited). Undefined when empty, so
 * a record never carries an empty map.
 */
export function pruneModelBlocks(
	blocks: ModelBlocks | undefined,
	now: number,
	servedModelId?: string,
): ModelBlocks | undefined {
	if (blocks === undefined) return undefined;
	const kept = Object.entries(blocks).filter(
		([key, block]) => block.blockedUntil > now && (servedModelId === undefined || !applies(key, servedModelId)),
	);
	return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

export function withModelBlock(
	blocks: ModelBlocks | undefined,
	key: string,
	blockedUntil: number,
	now: number,
): ModelBlocks {
	return mergeModelBlocks(pruneModelBlocks(blocks, now), { [key]: { blockedUntil } }, now) ?? {};
}

/**
 * Union of two block maps, the later expiry winning per key: a failure without a
 * reset hint, or a concurrent writer's stale snapshot, never shortens a live block.
 */
export function mergeModelBlocks(
	left: ModelBlocks | undefined,
	right: ModelBlocks | undefined,
	now: number,
): ModelBlocks | undefined {
	// A Map, then fromEntries: keys are user model ids, so `__proto__` must stay an own entry.
	const merged = new Map(Object.entries(pruneModelBlocks(left, now) ?? {}));
	for (const [key, block] of Object.entries(pruneModelBlocks(right, now) ?? {})) {
		merged.set(key, { blockedUntil: Math.max(merged.get(key)?.blockedUntil ?? 0, block.blockedUntil) });
	}
	return merged.size === 0 ? undefined : Object.fromEntries(merged);
}

export function describeModelBlocks(blocks: ModelBlocks | undefined, now: number): string[] {
	return Object.entries(pruneModelBlocks(blocks, now) ?? {}).map(
		([key, block]) => `blocked for ${key} until ${new Date(block.blockedUntil).toISOString()}`,
	);
}
