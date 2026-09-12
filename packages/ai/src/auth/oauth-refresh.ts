/**
 * OAuth token refresh that never holds the credential-store lock across the
 * network (#1542).
 *
 * `CredentialStore.modify` runs its callback under the store's mutual exclusion
 * (a file lock for `auth.json`). Running the up-to-15s HTTP exchange inside it
 * made one account's refresh block every other account, provider, and login
 * for longer than they wait. The exchange now runs outside `modify`; the write
 * re-acquires the lock and compare-and-swaps on the slot's refresh token, so a
 * slot rotated meanwhile by another process is adopted instead of overwritten.
 *
 * Within a process, concurrent refreshes of the same slot join one exchange.
 * Waiters that own the exchange (per-request resolution) cancel it once none of
 * them is waiting; the catalog-refresh lane joins without owning it, so a
 * superseded catalog refresh stops waiting but never aborts the exchange.
 */

import { raceWithAbortSignal } from "../utils/abort.ts";
import { mergeRefreshed, mergeRefreshedSlot, projectSlot } from "./pool/slots.ts";
import type { Credential, CredentialStore, OAuthAuth, OAuthCredential } from "./types.ts";

export const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

export interface OAuthRefreshRequest {
	credentials: CredentialStore;
	providerId: string;
	oauth: OAuthAuth;
	/** The credential (or slot projection) the caller found stale. */
	stale: OAuthCredential;
	slotName?: string | undefined;
	/** Re-evaluated against the latest stored value before the exchange. */
	isStale: (credential: OAuthCredential) => boolean;
	signal: AbortSignal;
	/** An owning waiter's abort cancels the exchange once no waiter remains; a non-owning one only stops waiting. */
	owning: boolean;
}

/** The provider rejected or timed out the token exchange. */
export class OAuthRefreshExchangeError extends Error {
	constructor(cause: unknown) {
		super("OAuth token exchange failed", { cause });
		this.name = "OAuthRefreshExchangeError";
	}
}

/** The credential store failed to read or write around the exchange. */
export class OAuthRefreshStoreError extends Error {
	constructor(cause: unknown) {
		super("Credential store operation failed", { cause });
		this.name = "OAuthRefreshStoreError";
	}
}

type InflightRefresh = {
	promise: Promise<Credential | undefined>;
	controller: AbortController;
	waiters: number;
	owned: boolean;
};

const inflightByStore = new WeakMap<CredentialStore, Map<string, InflightRefresh>>();

export function projectOAuthSlot(credential: OAuthCredential, name: string): OAuthCredential | undefined {
	const projected = projectSlot(credential, name);
	return projected?.type === "oauth" ? projected : undefined;
}

/**
 * Resolves with the post-refresh stored credential (the whole provider entry),
 * the newer stored value when another writer rotated the slot first, or
 * `undefined` when the credential or slot is gone.
 */
export function refreshOAuthCredential(request: OAuthRefreshRequest): Promise<Credential | undefined> {
	let registry = inflightByStore.get(request.credentials);
	if (!registry) {
		registry = new Map();
		inflightByStore.set(request.credentials, registry);
	}
	const key = `${request.providerId}\u0000${request.slotName ?? ""}\u0000${request.stale.refresh}`;
	let inflight = registry.get(key);
	if (!inflight) {
		const controller = new AbortController();
		const created: InflightRefresh = { controller, waiters: 0, owned: false, promise: Promise.resolve(undefined) };
		created.promise = exchangeAndStore(request, controller.signal).finally(() => {
			if (registry.get(key) === created) registry.delete(key);
		});
		registry.set(key, created);
		inflight = created;
	}
	join(inflight, request.signal, request.owning);
	return raceWithAbortSignal(inflight.promise, request.signal);
}

function join(inflight: InflightRefresh, signal: AbortSignal, owning: boolean): void {
	inflight.waiters++;
	if (owning) inflight.owned = true;
	const leave = () => {
		inflight.waiters--;
		if (inflight.waiters === 0 && inflight.owned) inflight.controller.abort(signal.reason);
	};
	if (signal.aborted) leave();
	else signal.addEventListener("abort", leave, { once: true });
}

async function exchangeAndStore(request: OAuthRefreshRequest, signal: AbortSignal): Promise<Credential | undefined> {
	const { credentials, providerId, oauth, slotName } = request;
	const view = (credential: Credential | undefined): OAuthCredential | undefined => {
		if (credential?.type !== "oauth") return undefined;
		return slotName === undefined ? credential : projectOAuthSlot(credential, slotName);
	};

	let latest: Credential | undefined;
	try {
		latest = await credentials.read(providerId, { signal });
	} catch (error) {
		throw new OAuthRefreshStoreError(error);
	}
	const current = view(latest);
	if (!current) return undefined; // logged out or slot removed meanwhile
	if (!request.isStale(current)) return latest; // another process/request refreshed

	let refreshed: Credential;
	try {
		const exchangeSignal = AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS)]);
		refreshed = await oauth.refresh(current, exchangeSignal);
		// A result that arrives after every owning waiter left is not persisted.
		signal.throwIfAborted();
	} catch (error) {
		throw new OAuthRefreshExchangeError(error);
	}

	try {
		// The write is not cancellable: the exchange consumed `current.refresh`, so
		// dropping the rotated token here would strand the account.
		return await credentials.modify(providerId, async (stored) => {
			if (stored?.type !== "oauth") return undefined; // logged out meanwhile
			const slot = view(stored);
			if (!slot || slot.refresh !== current.refresh) return undefined; // rotated meanwhile: adopt the stored value
			return slotName === undefined
				? mergeRefreshed(stored, refreshed)
				: mergeRefreshedSlot(stored, slotName, refreshed);
		});
	} catch (error) {
		throw new OAuthRefreshStoreError(error);
	}
}
