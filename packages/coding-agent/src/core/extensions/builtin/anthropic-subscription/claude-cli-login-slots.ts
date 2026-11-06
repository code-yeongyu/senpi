import { isDeepStrictEqual } from "node:util";
import type {
	AccountSlot,
	AnthropicSubscriptionCredential,
	ClaudeCliAccountCheck,
	ClaudeCliAccountSlot,
} from "./accounts.ts";
import type { ClaudeCliProfile } from "./claude-cli-auth-status.ts";

/**
 * Fields that describe the login in the slot's dir. When an undone re-login points the slot back at the old dir,
 * these go back to their old values even if another writer changed them meanwhile, because whatever was recorded
 * then (the profile the fresh dir reported, a connection test run on it) belongs to the discarded login.
 */
const LOGIN_BOUND_FIELDS = new Set(["dirId", "signedInAt", "profile", "check", "signInRequired"]);

/**
 * Reconnect keeps name, display name, model blocks and (on the credential) pin and order; blocks and sign-in-required
 * clear. `previous` is the slot as read under the same lock as the write, so nothing written to it meanwhile is lost.
 */
export function signedInSlot(
	previous: AccountSlot | undefined,
	name: string,
	dirId: string,
	profile: ClaudeCliProfile,
	at: number,
): ClaudeCliAccountSlot {
	return {
		name,
		...(previous?.displayName === undefined ? {} : { displayName: previous.displayName }),
		source: "login",
		store: "claude-cli",
		dirId,
		signedInAt: at,
		profile: { ...profile, checkedAt: at },
		...(previous?.modelBlocks === undefined ? {} : { modelBlocks: previous.modelBlocks }),
	};
}

export function withSlot(
	credential: AnthropicSubscriptionCredential,
	slot: AccountSlot,
): AnthropicSubscriptionCredential {
	const accounts = credential.accounts ?? [];
	return accounts.some((candidate) => candidate.name === slot.name)
		? { ...credential, accounts: accounts.map((candidate) => (candidate.name === slot.name ? slot : candidate)) }
		: { ...credential, accounts: [...accounts, slot] };
}

export function withCheck(
	credential: AnthropicSubscriptionCredential,
	name: string,
	check: ClaudeCliAccountCheck,
): AnthropicSubscriptionCredential {
	return {
		...credential,
		accounts: (credential.accounts ?? []).map((candidate) =>
			candidate.name === name && candidate.store === "claude-cli" ? { ...candidate, check } : candidate,
		),
	};
}

/**
 * The accounts with this login taken back. Only a slot that still points at this login's dir is touched: a new
 * account's slot is removed. For a re-login the login-bound fields always return to their previous values; every
 * other field this login wrote returns to its previous value unless another writer changed it meanwhile, so a
 * rename, a block or model blocks stored during the login survive (a block is time-bounded, and dropping it could
 * erase a real one).
 */
export function withoutThisLogin(
	accounts: readonly AccountSlot[],
	written: ClaudeCliAccountSlot,
	previous: AccountSlot | undefined,
): AccountSlot[] {
	return accounts.flatMap((candidate) => {
		if (candidate.name !== written.name || candidate.store !== "claude-cli" || candidate.dirId !== written.dirId)
			return [candidate];
		if (previous === undefined) return [];
		const restored: Record<string, unknown> = { ...candidate };
		const current = candidate as Record<string, unknown>;
		const ours = written as Record<string, unknown>;
		const before = previous as Record<string, unknown>;
		for (const key of new Set([...Object.keys(ours), ...Object.keys(before), ...LOGIN_BOUND_FIELDS])) {
			if (!LOGIN_BOUND_FIELDS.has(key) && !isDeepStrictEqual(current[key], ours[key])) continue;
			if (before[key] === undefined) delete restored[key];
			else restored[key] = before[key];
		}
		return [restored as AccountSlot];
	});
}

export function storedSubscription(value: unknown): AnthropicSubscriptionCredential | undefined {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "oauth"
		? (value as AnthropicSubscriptionCredential)
		: undefined;
}
