import type { CredentialStore } from "@earendil-works/pi-ai";
import { AUTH_BLOCK_REPROBE_MS } from "../../../credential-pool/auth-reprobe.ts";
import type { AccountSlot, AnthropicSubscriptionCredential, ClaudeCliAccountSlot } from "./accounts.ts";
import type { ClaudeCliAuthStatus } from "./claude-cli-auth-status.ts";
import { logContinuityEvent } from "./session-observability.ts";

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
	 * What `claude auth status` reports for a `claude-cli` account (senpi#4436). Such an account holds no grant to
	 * redeem: at its re-probe time `signed_in` clears the block, only `signed_out` marks the login expired
	 * (senpi#5350), and anything else keeps the timed block.
	 */
	readonly claudeCliStatus?: (slot: ClaudeCliAccountSlot) => Promise<ClaudeCliAuthStatus["state"]>;
};

/** The re-probe time passed (or the block predates re-probe times): the next request probes this account. */
function isProbeDue(slot: AccountSlot, now: number): boolean {
	return slot.blockedUntil === undefined || slot.blockedUntil <= now;
}

/**
 * A `login_expired` slot keeps its `auth_error` block as the self-heal cadence, so it is probed like any auth block.
 * That cadence survives `/claude-account unblock` only because `unblockProviderAccount` skips `auth_error` blocks
 * (account-management.ts:114); if unblock ever lifts them, a `login_expired` slot is never re-probed again.
 */
function isClaudeCliProbeDue(slot: AccountSlot, now: number): slot is ClaudeCliAccountSlot {
	return (
		slot.store === "claude-cli" &&
		slot.blockReason === "auth_error" &&
		(slot.signInRequired === undefined || slot.signInRequired === "login_expired") &&
		isProbeDue(slot, now)
	);
}

type LoginTransition = "claude_cli_login_expired" | "claude_cli_login_restored";

function probedSlot(stored: ClaudeCliAccountSlot, state: ClaudeCliAuthStatus["state"], now: number): AccountSlot {
	if (state === "signed_in") {
		const {
			blockReason: _reason,
			blockedUntil: _until,
			blockedAt: _at,
			signInRequired: _sign,
			...unblocked
		} = stored;
		return unblocked;
	}
	return {
		...stored,
		...(state === "signed_out" ? { signInRequired: "login_expired" as const } : {}),
		blockReason: "auth_error",
		blockedUntil: now + AUTH_BLOCK_REPROBE_MS,
		blockedAt: now,
	};
}

function transitionOf(stored: ClaudeCliAccountSlot, state: ClaudeCliAuthStatus["state"]): LoginTransition | undefined {
	if (state === "signed_out" && stored.signInRequired === undefined) return "claude_cli_login_expired";
	if (state === "signed_in" && stored.signInRequired === "login_expired") return "claude_cli_login_restored";
	return undefined;
}

async function probeClaudeCliSlot(
	input: AuthBlockRecoveryInput,
	slot: ClaudeCliAccountSlot,
	status: NonNullable<AuthBlockRecoveryInput["claudeCliStatus"]>,
): Promise<void> {
	const state = await status(slot);
	input.signal.throwIfAborted();
	let transition: LoginTransition | undefined;
	await input.store.modify(input.providerId, async (current) => {
		transition = undefined;
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		const stored = credential.accounts?.find((candidate) => candidate.name === slot.name);
		if (!stored || !isClaudeCliProbeDue(stored, input.now)) return current;
		transition = transitionOf(stored, state);
		const next = probedSlot(stored, state, input.now);
		return {
			...credential,
			accounts: (credential.accounts ?? []).map((candidate) => (candidate.name === slot.name ? next : candidate)),
		};
	});
	// Logged once the write landed: a store that retries the callback must not log the transition twice.
	if (transition !== undefined) logContinuityEvent(transition, { accountName: slot.name });
}

/**
 * Re-probes before a turn: a claude CLI account whose auth block is due for its re-probe (senpi#3264) asks
 * `claude auth status`; a login clears the block and a confirmed sign-out marks the login expired (senpi#5350).
 */
export async function recoverAuthBlockedSlots(input: AuthBlockRecoveryInput): Promise<AccountSlot[]> {
	const status = input.claudeCliStatus;
	const probes = status === undefined ? [] : input.accounts.filter((slot) => isClaudeCliProbeDue(slot, input.now));
	if (probes.length === 0) return [...input.accounts];
	let transientFailure: unknown;
	for (const probe of probes) {
		if (status === undefined) break;
		try {
			await probeClaudeCliSlot(input, probe, status);
		} catch (error) {
			input.signal.throwIfAborted();
			transientFailure = error;
		}
	}
	const accounts = await input.reload();
	// A due `login_expired` slot counts as usable here (its block time has passed), so a thrown probe on a pool of
	// only such slots does not throw `transientError`: the lane then drops them and throws the sign-in error, which
	// stops retries and model hops.
	if (transientFailure !== undefined && !accounts.some(input.isUsable)) {
		throw input.transientError(transientFailure);
	}
	return accounts;
}
