/**
 * The subscription accounts a usage poll can speak for, named exactly as turns name them in the store
 * (senpi#3684): a Claude account by its slot name, a ChatGPT account by its pool slot name (`default` for a
 * single login). The token is read only when a poll is actually due, through the credential store, and an
 * expiring Claude token is renewed by the same refresh a turn would run. Tokens never leave this module's
 * callers: they go into one request header and nowhere else.
 */
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { listSlots, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { AUTH_BLOCK_REPROBE_MS } from "../credential-pool/auth-reprobe.ts";
import {
	type AnthropicSubscriptionCredential,
	emptyCredential,
	envSlotToken,
	listAccounts,
	refreshSlot,
	type SlotRefresher,
} from "../extensions/builtin/anthropic-subscription/accounts.ts";
import { isGrantRejected } from "../extensions/builtin/anthropic-subscription/refresh-failure.ts";
import { CredentialStoreBusyError } from "../lockfile-policy.ts";
import type { UsageProvider } from "./usage-endpoints.ts";

const EXPIRING_WITHIN_MS = 5 * 60_000;
const STATUS_IN_TEXT = /\bstatus=(\d{3})\b/;
const MAX_CAUSE_LINKS = 16;

function causeChain(error: unknown): object[] {
	const links: object[] = [];
	let link: unknown = error;
	while (typeof link === "object" && link !== null && !links.includes(link) && links.length < MAX_CAUSE_LINKS) {
		links.push(link);
		link = Reflect.get(link, "cause");
	}
	return links;
}

/**
 * A background poll records the `auth_error` lock only on an explicit rejection from the token endpoint:
 * a 400/401 answer, or `invalid_grant` when no status is known (senpi#3695). `isGrantRejected` alone also
 * calls an HTML error page or a plain network failure rejected; a turn tolerates that, but a poll would then
 * lock a healthy login. The endpoint's own numeric status decides first; only without one is the text read,
 * and then only its first `status=`, because the flattened message carries the server's body after it.
 */
function tokenEndpointRejected(error: unknown): boolean {
	if (!isGrantRejected(error)) return false;
	const links = causeChain(error);
	for (const link of links) {
		const status: unknown = Reflect.get(link, "status");
		if (typeof status === "number") return status === 400 || status === 401;
	}
	for (const link of links) {
		const message: unknown = Reflect.get(link, "message");
		if (typeof message !== "string") continue;
		const status = STATUS_IN_TEXT.exec(message)?.[1];
		if (status !== undefined) return status === "400" || status === "401";
		if (message.includes("invalid_grant")) return true;
	}
	return false;
}

/** `undefined`: nothing usable to ask with right now (an expired ChatGPT token a turn will renew). */
export type AccessResult = { readonly access: string } | { readonly error: string } | undefined;

export interface PollAccount {
	readonly provider: UsageProvider;
	readonly account: string;
	access(signal: AbortSignal): Promise<AccessResult>;
}

export interface AccountSources {
	readonly store: CredentialStore;
	readonly env: (name: string) => string | undefined;
	readonly refresher: SlotRefresher;
	readonly now: () => number;
}

export const SIGN_IN_NEEDED = "auth stale - run /login";

export async function listPollAccounts(sources: AccountSources): Promise<PollAccount[]> {
	const [claude, chatgpt] = await Promise.all([
		sources.store.read("anthropic-subscription"),
		sources.store.read("chatgpt-subscription"),
	]);
	return [...claudeAccounts(claude, sources), ...chatgptAccounts(chatgpt, sources.now)];
}

function claudeAccounts(stored: Credential | undefined, sources: AccountSources): PollAccount[] {
	const credential = stored?.type === "oauth" ? (stored as AnthropicSubscriptionCredential) : emptyCredential();
	return listAccounts(credential, sources.env).map((slot) => ({
		provider: "anthropic-subscription",
		account: slot.name,
		async access(signal) {
			if (slot.source === "env") {
				const token = envSlotToken(sources.env, slot.name);
				return token === undefined ? undefined : { access: token };
			}
			const expiring = (expires: number) => sources.now() >= expires - EXPIRING_WITHIN_MS;
			if (!expiring(slot.expires)) return { access: slot.access };
			// A login the token endpoint already rejected is not re-redeemed here; a turn owns that recovery.
			if (slot.blockReason === "auth_error") return { error: SIGN_IN_NEEDED };
			try {
				const refreshed = await refreshSlot(
					sources.store,
					"anthropic-subscription",
					slot.name,
					sources.refresher,
					signal,
					expiring,
				);
				const renewed =
					refreshed?.type === "oauth"
						? listAccounts(refreshed as AnthropicSubscriptionCredential).find(
								(candidate) => candidate.name === slot.name,
							)
						: undefined;
				return renewed === undefined || expiring(renewed.expires)
					? { error: SIGN_IN_NEEDED }
					: { access: renewed.access };
			} catch (error) {
				// An aborted refresh (shutdown) and a busy store say nothing about the grant, exactly as in
				// auth-lane.ts prepareSlot: retried next interval, never a lock. A rejected grant is recorded on the
				// slot the way a turn records it, so later polls stop at the auth_error branch above instead of asking
				// the token endpoint again; only /login (or a turn's one-shot recovery) lifts it.
				if (signal.aborted || error instanceof CredentialStoreBusyError) return undefined;
				if (!tokenEndpointRejected(error)) return undefined;
				try {
					await markAuthRejected(sources, slot.name, slot.refresh);
				} catch {
					// The lock could not be written (a busy store): the next pass asks again and records it then.
				}
				return { error: SIGN_IN_NEEDED };
			}
		},
	}));
}

/**
 * Locks the slot only while it still holds the grant that was rejected: a /login, a sibling's refresh or a
 * turn's recovery may have written new material since, and that token must not be locked (as failover.ts
 * persistBlock guards).
 */
async function markAuthRejected(sources: AccountSources, name: string, rejectedRefresh: string): Promise<void> {
	const now = sources.now();
	await sources.store.modify("anthropic-subscription", async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		if (!credential.accounts?.some((slot) => slot.name === name && slot.refresh === rejectedRefresh)) return current;
		return {
			...credential,
			accounts: credential.accounts.map((slot) =>
				slot.name === name
					? { ...slot, blockedUntil: now + AUTH_BLOCK_REPROBE_MS, blockReason: "auth_error", blockedAt: now }
					: slot,
			),
		};
	});
}

function chatgptAccounts(stored: Credential | undefined, now: () => number): PollAccount[] {
	if (stored?.type !== "oauth") return [];
	return listSlots(stored as PooledCredential).flatMap((slot) =>
		slot.access === undefined || slot.access === ""
			? []
			: [
					{
						provider: "chatgpt-subscription" as const,
						account: slot.name,
						async access() {
							return slot.expires !== undefined && now() >= slot.expires
								? undefined
								: { access: slot.access ?? "" };
						},
					},
				],
	);
}
