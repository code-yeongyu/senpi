import type { CredentialStore } from "@earendil-works/pi-ai";
import { AUTH_BLOCK_REPROBE_MS } from "../../../credential-pool/auth-reprobe.ts";
import type { AccountSlot, AnthropicSubscriptionCredential, ClaudeCliAccountSlot } from "./accounts.ts";

export type AuthBlockRecoveryInput = {
	readonly store: CredentialStore;
	readonly providerId: string;
	readonly accounts: readonly AccountSlot[];
	readonly signal: AbortSignal;
	readonly reload: () => Promise<AccountSlot[]>;
	/** Whether an account can serve this request now. */
	readonly isUsable: (account: AccountSlot) => boolean;
	readonly now: number;
	/**
	 * The request error for a re-probe that could not finish (the CLI failed to answer, a busy store): the slot
	 * stays blocked and the next request tries it again.
	 */
	readonly transientError: (error: unknown) => Error;
	/**
	 * Whether `claude auth status` reports a login for a `claude-cli` account (senpi#4436). Such an account
	 * holds no grant to redeem: at its re-probe time a login clears the block, anything else keeps it.
	 */
	readonly claudeCliSignedIn?: (slot: ClaudeCliAccountSlot) => Promise<boolean>;
};

/** The re-probe time passed (or the block predates re-probe times): the next request probes this account. */
function isProbeDue(slot: AccountSlot, now: number): boolean {
	return slot.blockedUntil === undefined || slot.blockedUntil <= now;
}

function isClaudeCliProbeDue(slot: AccountSlot, now: number): slot is ClaudeCliAccountSlot {
	return (
		slot.store === "claude-cli" &&
		slot.blockReason === "auth_error" &&
		slot.signInRequired === undefined &&
		isProbeDue(slot, now)
	);
}

async function probeClaudeCliSlot(
	input: AuthBlockRecoveryInput,
	slot: ClaudeCliAccountSlot,
	signedIn: (slot: ClaudeCliAccountSlot) => Promise<boolean>,
): Promise<void> {
	const loggedIn = await signedIn(slot);
	input.signal.throwIfAborted();
	await input.store.modify(input.providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		const stored = credential.accounts?.find((candidate) => candidate.name === slot.name);
		if (!stored || !isClaudeCliProbeDue(stored, input.now)) return current;
		const { blockReason: _reason, blockedUntil: _until, blockedAt: _at, ...unblocked } = stored;
		const next: AccountSlot = loggedIn
			? unblocked
			: {
					...stored,
					blockReason: "auth_error",
					blockedUntil: input.now + AUTH_BLOCK_REPROBE_MS,
					blockedAt: input.now,
				};
		return {
			...credential,
			accounts: (credential.accounts ?? []).map((candidate) => (candidate.name === slot.name ? next : candidate)),
		};
	});
}

/**
 * Re-probes before a turn: a claude CLI account whose auth block is due for its re-probe (senpi#3264) asks
 * `claude auth status`, and a login clears the block.
 */
export async function recoverAuthBlockedSlots(input: AuthBlockRecoveryInput): Promise<AccountSlot[]> {
	const signedIn = input.claudeCliSignedIn;
	const probes = signedIn === undefined ? [] : input.accounts.filter((slot) => isClaudeCliProbeDue(slot, input.now));
	if (probes.length === 0) return [...input.accounts];
	let transientFailure: unknown;
	for (const probe of probes) {
		if (signedIn === undefined) break;
		try {
			await probeClaudeCliSlot(input, probe, signedIn);
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
