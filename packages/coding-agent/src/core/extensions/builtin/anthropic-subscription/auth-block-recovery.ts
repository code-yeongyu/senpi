import type { CredentialStore } from "@earendil-works/pi-ai";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	authGrantDigest,
	type SlotRefresher,
} from "./accounts.ts";

export type AuthBlockRecoveryInput = {
	readonly store: CredentialStore;
	readonly providerId: string;
	readonly accounts: readonly AccountSlot[];
	readonly refresher: SlotRefresher;
	readonly signal: AbortSignal;
	/** True when the token endpoint rejected the grant itself, not when it was throttled or unavailable. */
	readonly isGrantRejected: (error: unknown) => boolean;
	readonly reload: () => Promise<AccountSlot[]>;
	/** Whether an account can serve this request now; recovery runs only when none can. */
	readonly isUsable: (account: AccountSlot) => boolean;
	/**
	 * The request error for a refresh that failed for a reason other than a rejected grant (throttled,
	 * unavailable, a busy store): the slot stays blocked and the next request tries it again.
	 */
	readonly transientError: (error: unknown) => Error;
};

/**
 * An auth-blocked slot with saved refresh material gets one recovery per grant: the grant is
 * redeemed once, and a rejected grant, or the grant a recovery produced, is never redeemed again
 * until new material arrives through a refresh rotation or a re-login (senpi#2926).
 */
export function isAuthBlockRecoverable(slot: AccountSlot): boolean {
	return (
		slot.blockReason === "auth_error" &&
		slot.source !== "env" &&
		slot.refresh !== "" &&
		slot.authRecoveryGrant !== authGrantDigest(slot.refresh)
	);
}

function recovered(slot: AccountSlot, refreshed: Awaited<ReturnType<SlotRefresher>>): AccountSlot {
	const { blockReason: _blockReason, blockedUntil: _blockedUntil, ...unblocked } = slot;
	return {
		...unblocked,
		access: refreshed.access,
		refresh: refreshed.refresh,
		expires: refreshed.expires,
		authRecoveryGrant: authGrantDigest(refreshed.refresh),
	};
}

async function recoverSlot(input: AuthBlockRecoveryInput, name: string): Promise<void> {
	await input.store.modify(input.providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		const stored = credential.accounts?.find((slot) => slot.name === name);
		if (!stored || !isAuthBlockRecoverable(stored)) return current;
		let next: AccountSlot;
		try {
			next = recovered(stored, await input.refresher(stored.refresh, input.signal));
		} catch (error) {
			input.signal.throwIfAborted();
			if (!input.isGrantRejected(error)) throw error;
			next = { ...stored, authRecoveryGrant: authGrantDigest(stored.refresh) };
		}
		return {
			...credential,
			accounts: (credential.accounts ?? []).map((slot) => (slot.name === name ? next : slot)),
		};
	});
}

export async function recoverAuthBlockedSlots(input: AuthBlockRecoveryInput): Promise<AccountSlot[]> {
	const candidates = input.accounts.filter(isAuthBlockRecoverable);
	if (candidates.length === 0 || input.accounts.some(input.isUsable)) return [...input.accounts];
	let transientFailure: unknown;
	for (const candidate of candidates) {
		try {
			await recoverSlot(input, candidate.name);
		} catch (error) {
			input.signal.throwIfAborted();
			transientFailure = error;
		}
	}
	const accounts = await input.reload();
	if (transientFailure !== undefined && !accounts.some(input.isUsable)) {
		throw input.transientError(transientFailure);
	}
	return accounts;
}
