import type { Credential } from "../types.ts";
import { type CredentialSlot, listSlots, type PooledCredential } from "./slots.ts";

export type CredentialKind = Credential["type"];

/**
 * A slot's kind from its own material: OAuth tokens make an OAuth login, a key alone makes an API
 * key. A slot with neither is not classified, so a caller never drops or reports it by guess.
 */
export function slotKind(slot: Pick<CredentialSlot, "access" | "refresh" | "key">): CredentialKind | undefined {
	if (slot.access !== undefined || slot.refresh !== undefined) return "oauth";
	return slot.key !== undefined ? "api_key" : undefined;
}

/**
 * Kinds held by a credential's slots that its top-level type cannot use: slots are projected
 * through that type, so a slot of the other kind is never used (senpi#3448). Builds before the
 * fix appended a login of the other kind this way.
 */
export function unusedSlotKinds(credential: PooledCredential | undefined): ReadonlyArray<CredentialKind> {
	if (!credential || !Array.isArray(credential.accounts)) return [];
	const kinds = new Set<CredentialKind>();
	for (const slot of listSlots(credential)) {
		const kind = slotKind(slot);
		if (kind !== undefined && kind !== credential.type) kinds.add(kind);
	}
	return [...kinds];
}

/** The slots a credential can actually use: a slot of the other kind never projects (senpi#3486). */
export function slotsOfOwnKind(credential: PooledCredential): CredentialSlot[] {
	return listSlots(credential).filter((slot) => slotKind(slot) !== otherKind(credential.type));
}

const otherKind = (kind: CredentialKind): CredentialKind => (kind === "oauth" ? "api_key" : "oauth");
