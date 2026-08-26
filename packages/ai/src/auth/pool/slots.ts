import type { Credential } from "../types.ts";

export type { Credential };

export const DEFAULT_SLOT_NAME = "default";

export type CredentialSlotSource = "login" | "import" | "env";

export type CredentialSlot = {
	name: string;
	source?: CredentialSlotSource;
	key?: string;
	access?: string;
	refresh?: string;
	expires?: number;
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

function storedSlots(credential: PooledCredential): CredentialSlot[] {
	return Array.isArray(credential.accounts) ? credential.accounts : [];
}

function slotFromFlatCredential(credential: PooledCredential): CredentialSlot {
	if (credential.type === "oauth") {
		return {
			name: DEFAULT_SLOT_NAME,
			source: "login",
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires,
		};
	}
	return { name: DEFAULT_SLOT_NAME, source: "login", key: credential.key };
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

/**
 * Removes one slot. The credential is dropped entirely once its last slot is gone,
 * and a pin naming the removed slot is cleared so selection never points at a slot
 * that no longer exists.
 */
export function removeSlot(credential: PooledCredential | undefined, name: string): PooledCredential | undefined {
	if (!credential) return undefined;
	const accounts = listSlots(credential).filter((slot) => slot.name !== name);
	if (accounts.length === 0) return undefined;
	const next: PooledCredential = { ...credential, accounts };
	if (next.pinned === name) delete next.pinned;
	return next;
}

export function pinSlot(credential: PooledCredential, name: string): PooledCredential {
	assertValidSlotName(name);
	return { ...credential, pinned: name };
}

function slotFromFlatCredentialNamed(credential: Credential, name: string): CredentialSlot {
	if (credential.type === "oauth") {
		return {
			name,
			source: "login",
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires,
		};
	}
	return { name, source: "login", key: credential.key };
}

function nextLoginSlotName(credential: PooledCredential): string {
	const taken = new Set(listSlots(credential).map((slot) => slot.name));
	for (let index = 2; index < 1000; index++) {
		const candidate = `login-${index}`;
		if (!taken.has(candidate)) return candidate;
	}
	throw new Error("Credential pool is full");
}

/**
 * Appends an unnamed flat credential to a pool as a generated `login-N` slot. A
 * flat or absent current entry keeps today's whole-write shape so no existing
 * user's stored bytes change until a second credential actually exists.
 */
export function appendLoginSlot(current: PooledCredential | undefined, flat: Credential): Credential {
	if (!current || !Array.isArray(current.accounts) || current.accounts.length === 0) {
		return flat;
	}
	return upsertSlot(current, slotFromFlatCredentialNamed(flat, nextLoginSlotName(current)));
}

/**
 * Merges a rotated OAuth credential back into the pool: the slot whose material
 * matches the pre-refresh flat fields is updated in place together with those
 * flat fields, while every sibling and the pin survive byte-identical. A flat
 * current entry keeps today's whole-write shape.
 */
export function mergeRefreshed(current: PooledCredential, refreshed: Credential): Credential {
	if (!Array.isArray(current.accounts) || current.accounts.length === 0) {
		return refreshed;
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
