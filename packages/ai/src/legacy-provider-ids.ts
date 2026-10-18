export const LEGACY_PROVIDER_IDS = Object.freeze({
	"openai-codex": "chatgpt-subscription",
	"claude-sdk-oauth": "anthropic-subscription",
} as const);

type LegacyProviderId = keyof typeof LEGACY_PROVIDER_IDS;

export function normalizeProviderId(id: string): string {
	if (!Object.hasOwn(LEGACY_PROVIDER_IDS, id)) {
		return id;
	}
	return LEGACY_PROVIDER_IDS[id as LegacyProviderId];
}

export function normalizeModelRef(ref: string): string {
	const slash = ref.indexOf("/");
	if (slash === -1) {
		return normalizeProviderId(ref);
	}
	const provider = ref.slice(0, slash);
	const normalized = normalizeProviderId(provider);
	if (normalized === provider) {
		return ref;
	}
	return `${normalized}/${ref.slice(slash + 1)}`;
}

export function isLegacyProviderId(id: string): boolean {
	return Object.hasOwn(LEGACY_PROVIDER_IDS, id);
}

/**
 * Legacy spellings that normalize to `canonicalId`, for read boundaries that
 * must try the canonical key first and then fall back to state written by an
 * earlier version. Returns an empty array for an id that was never renamed.
 */
export function legacyProviderIdsFor(canonicalId: string): string[] {
	return Object.entries(LEGACY_PROVIDER_IDS)
		.filter(([, canonical]) => canonical === canonicalId)
		.map(([legacy]) => legacy);
}

/**
 * Read `record` by provider id, trying the canonical key first and then every
 * legacy spelling that normalizes to it. Never throws and never rewrites.
 */
export function readByProviderId<T>(record: Record<string, T> | undefined, providerId: string): T | undefined {
	if (record === undefined) return undefined;
	const canonical = normalizeProviderId(providerId);
	if (record[canonical] !== undefined) return record[canonical];
	for (const legacy of legacyProviderIdsFor(canonical)) {
		if (record[legacy] !== undefined) return record[legacy];
	}
	return undefined;
}

/**
 * Display names the renamed providers used to ship with. A user who types one
 * of these means the legacy provider just as much as someone typing its id, so
 * both are rejected with the same message.
 */
const LEGACY_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
	"openai codex": "openai-codex",
	"claude sdk oauth": "claude-sdk-oauth",
});

/**
 * The error a TYPED legacy provider id must produce: it names the new id so the
 * user can retype it, instead of a generic "Unknown provider" or a filtered
 * selector that silently shows nothing.
 *
 * This is for ids the user TYPES. Ids read from disk (settings, models.json,
 * sessions, auth.json) are normalized instead and never rejected.
 */
export function legacyProviderIdRejection(typed: string): string | undefined {
	const trimmed = typed.trim();
	const lowered = trimmed.toLowerCase();
	const legacyId = Object.hasOwn(LEGACY_PROVIDER_DISPLAY_NAMES, lowered)
		? LEGACY_PROVIDER_DISPLAY_NAMES[lowered]
		: Object.hasOwn(LEGACY_PROVIDER_IDS, lowered)
			? lowered
			: undefined;
	if (legacyId === undefined) return undefined;
	const canonical = LEGACY_PROVIDER_IDS[legacyId as LegacyProviderId];
	return `${legacyId} was renamed to ${canonical}. Use ${canonical}.`;
}
