import { LEGACY_PROVIDER_IDS } from "../../legacy-provider-ids.ts";
import type { ProviderEnv } from "../../types.ts";
import type { Credential } from "../types.ts";

export type { Credential };

export const DEFAULT_SLOT_NAME = "default";

export type CredentialSlotSource = "login" | "import" | "env";

/**
 * Account identity a provider reports at login. Two logins with the same `id` are
 * the same account, so the second refreshes the first's slot instead of adding one.
 */
export type CredentialIdentity = {
	/** Provider-scoped account key; the only field used for matching. */
	id: string;
	/** Presentation only (account lists); never used for matching. */
	email?: string;
};

/** Validates identity read from untrusted storage or a provider response. */
export function credentialIdentity(value: unknown): CredentialIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { id, email } = value as { id?: unknown; email?: unknown };
	if (typeof id !== "string" || id.trim() === "") return undefined;
	return typeof email === "string" && email.trim() !== "" ? { id, email } : { id };
}

/** Replaces `target`'s identity with `identity`, or drops it when there is none. */
function withIdentity<T extends object>(target: T, identity: CredentialIdentity | undefined): T {
	const { identity: _replaced, ...rest } = target as T & { identity?: unknown };
	return (identity === undefined ? rest : { ...rest, identity }) as T;
}

export type CredentialSlot = {
	/** Immutable operational identity. */
	name: string;
	/** Optional presentation metadata; never used for credential selection. */
	displayName?: string;
	source?: CredentialSlotSource;
	key?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	/** Provider-scoped values this account carries (a Kimi region, a Cloudflare account id). */
	env?: ProviderEnv;
	/** Recorded at login when the provider reports one; absent on slots from older builds. */
	identity?: CredentialIdentity;
};

export type PooledCredential = Credential & {
	accounts?: CredentialSlot[];
	pinned?: string;
};

const SLOT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidSlotName(name: string): void {
	if (!SLOT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`,
		);
	}
}

const UNSAFE_DISPLAY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Labels are bounded in terminal columns, not UTF-16 code units: 80 code units
 * of CJK render ~170 columns, which no footer segment can hold, while 41 emoji
 * render 82 columns yet count 82 code units. The bound is what the footer's
 * parenthesised provider segment can carry alongside a provider id.
 */
export const DISPLAY_NAME_MAX_COLUMNS = 32;

/** Code points that advance a cell without painting anything a user can see. */
const BLANK_DISPLAY_CHARACTER = /^[\s\p{M}\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0]$/u;
/** Invisible code points that are not whitespace, so trimming never removes them. */
const INVISIBLE_DISPLAY_CHARACTER = /^[\p{M}\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0]$/u;
const WIDE_DISPLAY_CHARACTER =
	/^(?:[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]|[\u{20000}-\u{3fffd}])$/u;

/**
 * Latin lookalikes for the Cyrillic letters a homoglyph label would use. Folded
 * only for the uniqueness comparison; the stored label keeps the user's script.
 */
const CYRILLIC_LOOKALIKES: Record<string, string> = {
	"\u0430": "a",
	"\u0432": "b",
	"\u0435": "e",
	"\u043a": "k",
	"\u043c": "m",
	"\u043d": "h",
	"\u043e": "o",
	"\u0440": "p",
	"\u0441": "c",
	"\u0442": "t",
	"\u0443": "y",
	"\u0445": "x",
	"\u0455": "s",
	"\u0456": "i",
	"\u0458": "j",
};

const displayNameGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal columns a label occupies, measured per grapheme cluster. */
export function displayNameColumns(value: string): number {
	let columns = 0;
	for (const { segment } of displayNameGraphemes.segment(value)) {
		const codePoint = segment.codePointAt(0);
		if (codePoint === undefined) continue;
		const base = String.fromCodePoint(codePoint);
		if (INVISIBLE_DISPLAY_CHARACTER.test(base)) continue;
		columns += WIDE_DISPLAY_CHARACTER.test(base) || segment.includes("\ufe0f") ? 2 : 1;
	}
	return columns;
}

/** The stored form: NFC, trimmed, internal whitespace runs collapsed to one space. */
function normalizeDisplayName(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/**
 * Comparison key for "unique per provider": compatibility-folded (fullwidth and
 * other compatibility forms), case-folded, invisible code points dropped, and
 * Cyrillic lookalikes mapped to Latin, so two labels that render identically
 * cannot both be stored.
 */
function displayNameKey(value: string): string {
	return [...normalizeDisplayName(value).normalize("NFKC").toLowerCase()]
		.filter((character) => !INVISIBLE_DISPLAY_CHARACTER.test(character))
		.map((character) => CYRILLIC_LOOKALIKES[character] ?? character)
		.join("");
}

/** Treat persisted metadata as untrusted presentation input. */
export function accountDisplayName(value: unknown): string | undefined {
	if (typeof value !== "string" || UNSAFE_DISPLAY_CHARACTERS.test(value)) return undefined;
	const normalized = normalizeDisplayName(value);
	const characters = [...normalized];
	// A leading combining mark glues the label onto whatever precedes it, and a
	// label made only of blank-rendering code points is indistinguishable from none.
	if (characters.length === 0 || /^\p{M}$/u.test(characters[0])) return undefined;
	if (characters.every((character) => BLANK_DISPLAY_CHARACTER.test(character))) return undefined;
	return displayNameColumns(normalized) <= DISPLAY_NAME_MAX_COLUMNS ? normalized : undefined;
}

export function accountLabel(account: { name: string; displayName?: string }): string {
	const displayName = accountDisplayName(account.displayName);
	return displayName === undefined ? account.name : `${displayName} (${account.name})`;
}

/** Pure metadata update; callers serialize this against the latest stored credential. */
export function renameSlotDisplayName(
	credential: PooledCredential,
	name: string,
	value: string | null,
): PooledCredential {
	assertValidSlotName(name);
	const accounts = Array.isArray(credential.accounts) ? credential.accounts : listSlots(credential);
	const target = accounts.find((slot) => slot.name === name);
	if (!target) throw new Error(`Stored provider account not found: ${name}`);
	if (target.source === "env") throw new Error(`Environment provider account cannot be renamed: ${name}`);
	const displayName = value === null ? undefined : accountDisplayName(value);
	if (value !== null && displayName === undefined) {
		throw new Error(
			`Display name must be 1-${DISPLAY_NAME_MAX_COLUMNS} terminal columns of visible text without control or formatting characters.`,
		);
	}
	if (
		displayName !== undefined &&
		accounts.some(
			(slot) =>
				slot.name !== name &&
				displayNameKey(accountDisplayName(slot.displayName) ?? "") === displayNameKey(displayName),
		)
	) {
		throw new Error("Display name is already used by another account for this provider.");
	}
	return {
		...credential,
		accounts: accounts.map((slot) => {
			if (slot.name !== name) return slot;
			const { displayName: _displayName, ...unchanged } = slot;
			return displayName === undefined ? unchanged : { ...unchanged, displayName };
		}),
	};
}

function storedSlots(credential: PooledCredential): CredentialSlot[] {
	return Array.isArray(credential.accounts) ? credential.accounts : [];
}

function credentialSlotEnv(credential: Credential): { env: ProviderEnv } | Record<string, never> {
	const value = credential.env;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const env: ProviderEnv = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry !== "string") return {};
		env[name] = entry;
	}
	return { env };
}

function slotFromFlatCredential(credential: PooledCredential): CredentialSlot {
	return slotFromFlatCredentialNamed(credential, DEFAULT_SLOT_NAME);
}

/**
 * A flat credential written by a build predating pools is read as a one-slot pool
 * without writing anything back; the caller decides whether a write ever happens.
 */
export function listSlots(credential: PooledCredential | undefined): CredentialSlot[] {
	if (!credential) return [];
	const slots = storedSlots(credential);
	return slots.length > 0 ? [...slots] : [slotFromFlatCredential(credential)];
}

export function findSlot(credential: PooledCredential | undefined, name: string): CredentialSlot | undefined {
	return listSlots(credential).find((slot) => slot.name === name);
}

/**
 * Replaces or appends one slot while every sibling, the pin, and the flat
 * top-level credential survive untouched. The flat fields stay as written so a
 * build that ignores `accounts` still authenticates from them.
 */
export function upsertSlot(credential: PooledCredential | undefined, slot: CredentialSlot): PooledCredential {
	assertValidSlotName(slot.name);
	const base: PooledCredential =
		credential ??
		(slot.access !== undefined || slot.refresh !== undefined
			? { type: "oauth", access: slot.access ?? "", refresh: slot.refresh ?? "", expires: slot.expires ?? 0 }
			: { type: "api_key", key: slot.key });
	const existing = listSlots(base);
	const index = existing.findIndex((candidate) => candidate.name === slot.name);
	const accounts =
		index >= 0
			? existing.map((candidate) => (candidate.name === slot.name ? { ...candidate, ...slot } : candidate))
			: [...existing, slot];
	return { ...base, accounts };
}

/** Whether the flat top-level fields are this slot's material rather than a sibling's. */
function slotMirrorsFlat(credential: PooledCredential, slot: CredentialSlot): boolean {
	if (credential.type === "oauth") return slot.access === credential.access || slot.refresh === credential.refresh;
	return slot.key === credential.key;
}

/** Rewrites the flat top-level projection to carry the given slot's material. */
function projectFlatFields(credential: PooledCredential, slot: CredentialSlot): PooledCredential {
	const env = slot.env === undefined ? {} : { env: slot.env };
	const identity = credentialIdentity(slot.identity);
	if (credential.type === "oauth") {
		if (slot.access === undefined || slot.refresh === undefined || slot.expires === undefined) return credential;
		return withIdentity(
			{ ...credential, access: slot.access, refresh: slot.refresh, expires: slot.expires, ...env },
			identity,
		);
	}
	return withIdentity({ ...credential, key: slot.key, ...env }, identity);
}

/**
 * Removes one slot. The credential is dropped entirely once its last slot is gone,
 * and a pin naming the removed slot is cleared so selection never points at a slot
 * that no longer exists.
 *
 * When the removed slot was the one the flat top-level fields projected, those
 * fields are re-projected from the first survivor. Without that the pool keeps
 * authenticating with the deleted account's material: a credential with a single
 * remaining slot does not enter the rotation path, so ordinary requests resolve
 * the flat projection and would keep using exactly the account the user removed.
 * `accounts` is preserved either way, so the entry stays a pool.
 */
export function removeSlot(credential: PooledCredential | undefined, name: string): PooledCredential | undefined {
	if (!credential) return undefined;
	const existing = listSlots(credential);
	const removed = existing.find((slot) => slot.name === name);
	const accounts = existing.filter((slot) => slot.name !== name);
	if (accounts.length === 0) return undefined;
	const reprojected =
		removed && slotMirrorsFlat(credential, removed) ? projectFlatFields(credential, accounts[0]) : credential;
	const next: PooledCredential = { ...reprojected, accounts };
	if (next.pinned === name) delete next.pinned;
	return next;
}

export function pinSlot(credential: PooledCredential, name: string): PooledCredential {
	assertValidSlotName(name);
	return { ...credential, pinned: name };
}

/**
 * Projects one named slot onto the flat credential shape for request-scoped
 * resolution; pool bookkeeping fields are stripped so provider handlers see a
 * plain credential and never write pool state back through the projection.
 */
export function projectSlot(credential: PooledCredential | undefined, name: string): Credential | undefined {
	if (!credential) return undefined;
	const slot = findSlot(credential, name);
	if (!slot) return undefined;
	const { accounts: _accounts, pinned: _pinned, ...flat } = credential;
	const env = slot.env === undefined ? {} : { env: slot.env };
	const identity = credentialIdentity(slot.identity);
	if (flat.type === "oauth") {
		if (slot.access === undefined || slot.refresh === undefined || slot.expires === undefined) return undefined;
		return withIdentity(
			{ ...flat, access: slot.access, refresh: slot.refresh, expires: slot.expires, ...env },
			identity,
		);
	}
	return withIdentity({ ...flat, key: slot.key, ...env }, identity);
}

function slotFromFlatCredentialNamed(credential: Credential, name: string): CredentialSlot {
	const identity = credentialIdentity((credential as { identity?: unknown }).identity);
	const identityField = identity === undefined ? {} : { identity };
	if (credential.type === "oauth") {
		return {
			name,
			source: "login",
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires,
			...credentialSlotEnv(credential),
			...identityField,
		};
	}
	return { name, source: "login", key: credential.key, ...credentialSlotEnv(credential), ...identityField };
}

/**
 * A re-login of an account the pool already holds: the slot keeps its name,
 * display name and source, takes the login's material, and drops everything
 * else it carried (including lane-persisted block state), because a block
 * belongs to the material that earned it.
 */
function refreshSlotInPlace(current: PooledCredential, known: CredentialSlot, flat: Credential): PooledCredential {
	const { name: _name, source: _source, ...material } = slotFromFlatCredentialNamed(flat, known.name);
	const replaced: CredentialSlot = {
		name: known.name,
		...(known.displayName === undefined ? {} : { displayName: known.displayName }),
		source: known.source ?? "login",
		...material,
	};
	if (!Array.isArray(current.accounts) || current.accounts.length === 0) return projectFlatFields(current, replaced);
	const accounts = current.accounts.map((slot) => (slot.name === known.name ? replaced : slot));
	const base = slotMirrorsFlat(current, known) ? projectFlatFields(current, replaced) : current;
	return { ...base, accounts };
}

function nextLoginSlotName(credential: PooledCredential): string {
	const taken = new Set(listSlots(credential).map((slot) => slot.name));
	for (let index = 2; index < 1000; index++) {
		const candidate = `login-${index}`;
		if (!taken.has(candidate)) return candidate;
	}
	throw new Error("Credential pool is full");
}

function providedSlots(credential: Credential): CredentialSlot[] | undefined {
	const accounts = (credential as PooledCredential).accounts;
	return Array.isArray(accounts) && accounts.length > 0 ? accounts : undefined;
}

/**
 * Unions a provider-owned pool onto the value read under the credential lock.
 * `current` wins for every name it already holds: the provider built its
 * object from a snapshot taken BEFORE the interactive browser round trip, so a
 * sibling account that rotated its refresh token or earned a rate-limit block
 * during that window must not be rewound to the snapshot. Only names that do
 * not exist yet are appended.
 */
function mergeProvidedPool(
	current: PooledCredential,
	existing: readonly CredentialSlot[],
	provided: readonly CredentialSlot[],
): PooledCredential {
	const known = new Set(existing.map((slot) => slot.name));
	const added = provided.filter((slot) => !known.has(slot.name));
	return added.length === 0 ? current : { ...current, accounts: [...existing, ...added] };
}

/**
 * Appends an unnamed flat credential to a pool as a generated `login-N` slot.
 * An absent current entry keeps today's whole-write shape; a flat current entry
 * is promoted to a pool so the legacy credential stays reachable as `default`
 * instead of being overwritten by the second login.
 *
 * A login result that already carries its own populated `accounts` array is a
 * provider-owned pool, and a provider that already holds a POOL names the
 * account this login created itself. That pool is MERGED onto `current` rather
 * than written through: a pre-browser-flow snapshot must never overwrite what
 * concurrent writers stored meanwhile. A flat `current` keeps the whole-write
 * shape - the provider echoes the flat fields it read, so there is nothing to
 * preserve and the login must not be dropped on a name collision.
 *
 * `onAllocated` reports the account this login committed, so a caller can name
 * it in a receipt without re-reading storage.
 */
export function appendLoginSlot(
	current: PooledCredential | undefined,
	flat: Credential,
	onAllocated?: (name: string, origin: "generated" | "provider" | "updated") => void,
): Credential {
	const provided = providedSlots(flat);
	if (provided) {
		// Provider-owned envelopes identify an addition by immutable ID, never by
		// token equality or array position. Ambiguous envelopes have no receipt.
		const previous = new Set(
			(current && Array.isArray(current.accounts) ? current.accounts : listSlots(current)).map((slot) => slot.name),
		);
		const added = provided.filter((slot) => !previous.has(slot.name));
		if (added.length === 1 && SLOT_NAME_PATTERN.test(added[0].name) && added[0].source !== "env") {
			onAllocated?.(added[0].name, "provider");
		}
	}
	if (!current) {
		if (!provided) onAllocated?.(DEFAULT_SLOT_NAME, "generated");
		return flat;
	}
	const storedAccounts = Array.isArray(current.accounts) ? current.accounts : undefined;
	if (provided) {
		// A pool merges onto the stored pool; a flat current keeps the whole-write
		// shape because the provider's accounts already carry this login.
		return storedAccounts ? mergeProvidedPool(current, storedAccounts, provided) : flat;
	}
	const identity = credentialIdentity((flat as { identity?: unknown }).identity);
	const known =
		identity === undefined
			? undefined
			: listSlots(current).find((slot) => credentialIdentity(slot.identity)?.id === identity.id);
	if (known) {
		const refreshed = refreshSlotInPlace(current, known, flat);
		onAllocated?.(known.name, "updated");
		return refreshed;
	}
	const name = nextLoginSlotName(current);
	const next = upsertSlot(current, slotFromFlatCredentialNamed(flat, name));
	onAllocated?.(name, "generated");
	return next;
}

/**
 * Material a provider writes into the flat credential when the real token lives
 * outside auth.json (an SDK subprocess or a vendor CLI owns it): the literal
 * `<providerId>-managed` in both OAuth fields. It is a marker, never a token.
 */
export function managedSentinelMaterial(providerId: string): string {
	return `${providerId}-managed`;
}

const LEGACY_SENTINEL_MATERIALS: ReadonlyMap<string, string> = new Map(
	Object.entries(LEGACY_PROVIDER_IDS).map(([legacyId, canonicalId]) => [
		canonicalId,
		managedSentinelMaterial(legacyId),
	]),
);

/**
 * Every sentinel material a stored credential may legitimately carry for this
 * provider: the canonical `<providerId>-managed` plus the legacy material of
 * any renamed ancestor id, because credentials written before a rename keep
 * the old literal verbatim.
 */
export function managedSentinelMaterials(providerId: string): string[] {
	const materials = [managedSentinelMaterial(providerId)];
	const legacy = LEGACY_SENTINEL_MATERIALS.get(providerId);
	if (legacy !== undefined && !materials.includes(legacy)) materials.push(legacy);
	return materials;
}

/**
 * A POOL SLOT carrying that marker can never authenticate: `projectSlot` hands
 * it to the provider's `check`, which rejects it, and the request dies with
 * "Provider is not configured". Slots like that exist only because a shipped
 * build appended a provider-owned pool's flat sentinel as a generated `login-N`
 * slot.
 */
export function isManagedSentinelSlot(providerId: string, slot: CredentialSlot): boolean {
	const materials = managedSentinelMaterials(providerId);
	return materials.includes(slot.access ?? "") && slot.refresh === slot.access;
}

/**
 * Drops those poisoned slots from a stored credential, clearing a pin that
 * named one. Returns `undefined` when the credential holds none, so a caller
 * can tell a repair from a no-op and only rewrite storage when the bytes
 * actually change.
 */
export function repairManagedSentinelSlots(providerId: string, credential: Credential): PooledCredential | undefined {
	const pooled = credential as PooledCredential;
	if (!Array.isArray(pooled.accounts)) return undefined;
	const kept = pooled.accounts.filter((slot) => !isManagedSentinelSlot(providerId, slot));
	if (kept.length === pooled.accounts.length) return undefined;
	const repaired: PooledCredential = { ...pooled, accounts: kept };
	if (repaired.pinned !== undefined && !kept.some((slot) => slot.name === repaired.pinned)) delete repaired.pinned;
	return repaired;
}

/**
 * Merges a rotated OAuth credential back into the pool: the slot whose material
 * matches the pre-refresh flat fields is updated in place together with those
 * flat fields, while every sibling and the pin survive byte-identical. A flat
 * current entry keeps today's whole-write shape.
 */
/**
 * Merges a rotated OAuth credential into the NAMED slot. The flat top-level
 * projection rotates only when it mirrored that slot's previous material, so
 * refreshing a secondary slot never disturbs what an older binary reads.
 */
export function mergeRefreshedSlot(current: PooledCredential, name: string, refreshed: Credential): Credential {
	if (refreshed.type !== "oauth" || current.type !== "oauth") return current;
	if (!Array.isArray(current.accounts) || current.accounts.length === 0) return mergeRefreshed(current, refreshed);
	const target = current.accounts.find((slot) => slot.name === name);
	if (!target) return current;
	const rotated = { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
	const accounts = current.accounts.map((slot) => (slot === target ? { ...slot, ...rotated } : slot));
	const mirrorsFlat = target.access === current.access || target.refresh === current.refresh;
	return mirrorsFlat ? { ...current, ...rotated, accounts } : { ...current, accounts };
}

export function mergeRefreshed(current: PooledCredential, refreshed: Credential): Credential {
	if (!Array.isArray(current.accounts) || current.accounts.length === 0) {
		// A token exchange does not re-report the account; keep the identity the login recorded.
		const identity = credentialIdentity((current as { identity?: unknown }).identity);
		if (identity === undefined || refreshed.type !== "oauth" || credentialIdentity(refreshed.identity))
			return refreshed;
		return { ...refreshed, identity };
	}
	if (refreshed.type !== "oauth" || current.type !== "oauth") return refreshed;
	const target = current.accounts.find((slot) => slot.access === current.access || slot.refresh === current.refresh);
	const rotated = {
		access: refreshed.access,
		refresh: refreshed.refresh,
		expires: refreshed.expires,
	};
	const accounts = target
		? current.accounts.map((slot) => (slot === target ? { ...slot, ...rotated } : slot))
		: current.accounts;
	return { ...current, ...rotated, accounts };
}
