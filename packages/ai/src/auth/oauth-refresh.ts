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
 * Persistent stores inject a session-scoped lock around read/exchange/write so
 * two processes cannot consume the same rotating token. Within a process,
 * concurrent refreshes of the same slot join one exchange.
 * Waiters that own the exchange (per-request resolution) cancel it once none of
 * them is waiting; the catalog-refresh lane joins without owning it, so a
 * superseded catalog refresh stops waiting but never aborts the exchange.
 */

import { raceWithAbortSignal } from "../utils/abort.ts";
import { oauthRefreshFailureCause } from "../utils/oauth-refresh-error.ts";
import { refreshContinuity } from "./oauth-refresh-continuity.ts";
import { DEFAULT_SLOT_NAME, findFlatOAuthSlot, mergeRefreshed, mergeRefreshedSlot, projectSlot } from "./pool/slots.ts";
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

/** The flat credential cannot be safely associated with one saved account. */
export class OAuthRefreshIdentityError extends Error {
	constructor(providerId: string) {
		super(
			`The saved ${providerId} credential does not identify a unique account. Select an account or sign in again.`,
		);
		this.name = "OAuthRefreshIdentityError";
	}
}

class OAuthRefreshAccountChangedError extends OAuthRefreshIdentityError {
	constructor(providerId: string) {
		super(providerId);
		this.message = `The saved ${providerId} account changed during authentication. Retry the request.`;
	}
}

async function assertAccountContinuity(
	providerId: string,
	original: OAuthCredential,
	current: OAuthCredential | undefined,
	accountIdentity: OAuthAuth["accountIdentity"],
): Promise<void> {
	if (!current) return;
	const originalIdentity = accountIdentity?.(original);
	const currentIdentity = accountIdentity?.(current);
	if (originalIdentity !== undefined && currentIdentity !== undefined) {
		if (originalIdentity !== currentIdentity) throw new OAuthRefreshAccountChangedError(providerId);
		return;
	}
	if (original.access !== current.access && original.refresh !== current.refresh) {
		if (
			current.refreshContinuity !== undefined &&
			current.refreshContinuity === (await refreshContinuity(original, current))
		) {
			return;
		}
		throw new OAuthRefreshAccountChangedError(providerId);
	}
}

type InflightRefresh = {
	promise: Promise<Credential | undefined>;
	controller: AbortController;
	waiters: number;
	owned: boolean;
};

const inflightByStore = new WeakMap<CredentialStore, Map<string, InflightRefresh>>();
type RefreshObserver = (providerId: string, promise: InflightRefresh["promise"]) => void;
const refreshObserversByStore = new WeakMap<CredentialStore, Set<RefreshObserver>>();

/** Collect exchanges through the clear's publication, then wait for discarded-token revocation too. */
export function captureOAuthRefreshes(credentials: CredentialStore, providerId: string): () => Promise<boolean> {
	const pending: Promise<boolean>[] = [];
	let observers = refreshObserversByStore.get(credentials);
	if (!observers) {
		observers = new Set();
		refreshObserversByStore.set(credentials, observers);
	}
	const observe: RefreshObserver = (id, promise) => {
		if (id === providerId)
			pending.push(
				promise.then(
					() => true,
					// An account-switch rejection occurs only before the exchange or after its cleanup.
					(error: unknown) => error instanceof OAuthRefreshAccountChangedError,
				),
			);
	};
	observers.add(observe);
	const prefix = `${providerId}\u0000`;
	for (const [key, refresh] of inflightByStore.get(credentials) ?? []) {
		if (key.startsWith(prefix)) observe(providerId, refresh.promise);
	}
	return async () => {
		observers.delete(observe);
		const results = await Promise.all(pending);
		return results.every(Boolean);
	};
}

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
		created.promise = serializeExchange(request, controller.signal).finally(() => {
			if (registry.get(key) === created) registry.delete(key);
		});
		registry.set(key, created);
		for (const observe of refreshObserversByStore.get(request.credentials) ?? []) {
			observe(request.providerId, created.promise);
		}
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

function refreshSlotName(
	credential: OAuthCredential,
	slotName: string | undefined,
	accountIdentity: OAuthAuth["accountIdentity"],
): string {
	// Flat/catalog resolution and named resolution of its mirrored slot must
	// acquire the same lock. Matching locates the stable ID; it is not the key.
	return slotName ?? findFlatOAuthSlot(credential, accountIdentity)?.name ?? DEFAULT_SLOT_NAME;
}

async function serializeExchange(request: OAuthRefreshRequest, signal: AbortSignal): Promise<Credential | undefined> {
	const { credentials, providerId, slotName, oauth } = request;
	const originalSlot = slotName === undefined ? findFlatOAuthSlot(request.stale, oauth.accountIdentity) : undefined;
	const originalAccount = slotName === undefined ? oauth.accountIdentity?.(request.stale) : undefined;
	const assertOriginalAccount = (credential: Credential | undefined) => {
		if (slotName !== undefined || credential?.type !== "oauth") return;
		const currentSlot = findFlatOAuthSlot(credential, oauth.accountIdentity);
		const currentAccount = oauth.accountIdentity?.(credential);
		if (
			(originalSlot && currentSlot && originalSlot.name !== currentSlot.name) ||
			(originalAccount !== undefined && currentAccount !== undefined && originalAccount !== currentAccount)
		) {
			throw new OAuthRefreshAccountChangedError(providerId);
		}
	};
	let identity = refreshSlotName(request.stale, slotName, oauth.accountIdentity);
	let retry: boolean;
	do {
		retry = false;
		const run = async (lockSignal: AbortSignal) => {
			const latest = await credentials.read(providerId, { signal: lockSignal });
			assertOriginalAccount(latest);
			if (credentials.withRefreshLock && latest?.type === "oauth") {
				const currentIdentity = refreshSlotName(latest, slotName, oauth.accountIdentity);
				if (currentIdentity !== identity) {
					// A login/removal changed the flat projection while we waited.
					// Release before acquiring that account's lock; never nest locks.
					identity = currentIdentity;
					retry = true;
					return undefined;
				}
			}
			return exchangeAndStore(request, lockSignal, latest);
		};
		try {
			const result = credentials.withRefreshLock
				? await credentials.withRefreshLock(providerId, identity, run, { signal })
				: await run(signal);
			if (!retry) {
				assertOriginalAccount(result);
				return result;
			}
		} catch (error) {
			if (
				error instanceof OAuthRefreshExchangeError ||
				error instanceof OAuthRefreshStoreError ||
				error instanceof OAuthRefreshIdentityError
			)
				throw error;
			throw new OAuthRefreshStoreError(error);
		}
	} while (retry);
	return undefined;
}

async function exchangeAndStore(
	request: OAuthRefreshRequest,
	signal: AbortSignal,
	latest: Credential | undefined,
): Promise<Credential | undefined> {
	const { credentials, providerId, oauth, slotName } = request;
	const view = (credential: Credential | undefined): OAuthCredential | undefined => {
		if (credential?.type !== "oauth") return undefined;
		const projected = slotName === undefined ? credential : projectOAuthSlot(credential, slotName);
		if (projected?.signedOut === true || (!projected?.access && !projected?.refresh)) return undefined;
		return projected;
	};

	const current = view(latest);
	if (!current) return undefined; // logged out or slot removed meanwhile
	await assertAccountContinuity(providerId, request.stale, current, oauth.accountIdentity);
	if (!request.isStale(current)) return latest; // another process/request refreshed

	const initialFlatSlot = slotName === undefined ? findFlatOAuthSlot(current, oauth.accountIdentity) : undefined;
	if (slotName === undefined && Array.isArray(current.accounts) && current.accounts.length > 0 && !initialFlatSlot) {
		throw new OAuthRefreshIdentityError(providerId);
	}
	const expectedSlot =
		initialFlatSlot === undefined
			? undefined
			: { name: initialFlatSlot.name, access: initialFlatSlot.access, refresh: initialFlatSlot.refresh };
	const initialFlat = latest?.type === "oauth" ? { access: latest.access, refresh: latest.refresh } : undefined;

	let refreshed: Credential;
	try {
		const exchangeSignal = AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS)]);
		refreshed = await oauth.refresh(current, exchangeSignal);
		// A result that arrives after every owning waiter left is not persisted.
		if (!oauth.revoke) signal.throwIfAborted();
	} catch (error) {
		signal.throwIfAborted();
		const causeClass = oauthRefreshFailureCause(error);
		if (causeClass !== undefined) {
			console.warn(
				"OAuth refresh unavailable",
				JSON.stringify({
					provider: providerId,
					...(slotName ? { slot: slotName } : {}),
					cause: causeClass,
				}),
			);
		}
		throw new OAuthRefreshExchangeError(error);
	}

	let continuityFailure: { error: unknown } | undefined;
	if (refreshed.type === "oauth") {
		const { refreshContinuity: _oldContinuity, ...tokens } = refreshed;
		refreshed = tokens;
		try {
			refreshed = { ...tokens, refreshContinuity: await refreshContinuity(current, tokens) };
		} catch (error) {
			// Persist the consumed token even when continuity metadata cannot be computed.
			continuityFailure = { error };
		}
	}

	let discarded = false;
	let reconciliationLost = false;
	let post: Credential | undefined;
	try {
		// The write is not cancellable: the exchange consumed `current.refresh`, so
		// dropping the rotated token here would strand the account.
		post = await credentials.modify(providerId, async (stored) => {
			const slot = view(stored);
			if (
				stored?.type !== "oauth" ||
				!slot ||
				slot.refresh !== current.refresh ||
				(oauth.revoke && signal.aborted)
			) {
				discarded = true;
				return undefined; // logged out, rotated, or cancelled meanwhile
			}
			if (slotName === undefined) {
				const matched = findFlatOAuthSlot(stored, oauth.accountIdentity);
				const unchanged =
					expectedSlot !== undefined &&
					matched?.name === expectedSlot.name &&
					matched.access === expectedSlot.access &&
					matched.refresh === expectedSlot.refresh;
				if (Array.isArray(stored.accounts) && stored.accounts.length > 0 && !unchanged) {
					reconciliationLost = true;
				}
				return mergeRefreshed(stored, refreshed, unchanged ? matched : null);
			}
			const flatUnchanged =
				initialFlat !== undefined && stored.access === initialFlat.access && stored.refresh === initialFlat.refresh;
			const matchedFlat = flatUnchanged ? findFlatOAuthSlot(stored, oauth.accountIdentity) : undefined;
			return mergeRefreshedSlot(stored, slotName, refreshed, matchedFlat ?? null);
		});
	} catch (error) {
		throw new OAuthRefreshStoreError(error);
	}
	// A refresh that lost ownership must not leave a renewable remote session.
	// Do not revoke material another writer already stored as the current token.
	if (discarded && oauth.revoke && refreshed.type === "oauth" && view(post)?.refresh !== refreshed.refresh) {
		const result = await oauth.revoke({ ...current, ...refreshed });
		if (result.status !== "revoked") {
			throw new OAuthRefreshExchangeError(new Error("Discarded refresh revocation was not confirmed"));
		}
	}
	if (continuityFailure) throw new OAuthRefreshStoreError(continuityFailure.error);
	if (discarded) await assertAccountContinuity(providerId, current, view(post), oauth.accountIdentity);
	if (!discarded && reconciliationLost) throw new OAuthRefreshIdentityError(providerId);
	return view(post) ? post : undefined;
}
