import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { captureOAuthRefreshes } from "./oauth-refresh.ts";
import { listSlots, projectSlot, type PooledCredential } from "./pool/slots.ts";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
	LogoutOptions,
	OAuthAuth,
	OAuthCredential,
	OAuthRevocationResult,
} from "./types.ts";

/** Clear session secrets without discarding the registration's non-secret metadata. */
function clearTokens<T extends object>(credential: T) {
	const cleared = { ...credential, access: "", refresh: "", expires: 0, signedOut: true };
	Reflect.deleteProperty(cleared, "idToken");
	return cleared;
}

/** Capture and clear atomically before network work, so later logins are not cleared. */
export async function revokeStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	options?: LogoutOptions,
): Promise<OAuthRevocationResult | undefined> {
	const revoke = oauth.revoke;
	if (!revoke) return undefined;
	let handled = false;
	const targets: OAuthCredential[] = [];
	let refreshes = Promise.resolve(true);
	const settleRefreshes = captureOAuthRefreshes(credentials, providerId);
	// Deliberately not cancellable: even an interrupted remote revoke must clear locally.
	// Slot selection and its token snapshot share the same lock as refresh writes.
	await credentials
		.modify(providerId, async (current: PooledCredential | undefined) => {
			if (current?.type !== "oauth") return undefined;
			handled = true;
			const slots = listSlots(current).filter(
				(slot) => options?.slotId === undefined || slot.name === options.slotId,
			);
			if (!slots.length) return undefined;
			for (const slot of slots) {
				const projected = projectSlot(current, slot.name);
				if (projected?.type === "oauth") targets.push({ ...projected, ...slot });
			}
			const names = new Set(slots.map((slot) => slot.name));
			const accounts = Array.isArray(current.accounts)
				? current.accounts.map((slot) => (names.has(slot.name) ? clearTokens(slot) : slot))
				: undefined;
			let next =
				options?.slotId === undefined ||
				slots.some((slot) => slot.refresh === current.refresh && slot.access === current.access)
					? clearTokens(current)
					: { ...current };
			if (accounts) {
				next = { ...next, accounts };
				// Keep the legacy flat projection on a surviving signed-in sibling, if one exists.
				const active = accounts.find((slot) => slot.access && slot.refresh);
				if (next.signedOut === true && active) {
					next = { ...next, ...active, signedOut: false };
				}
			}
			return next;
		})
		.finally(() => {
			// Include exchanges admitted until the store publishes the cleared slot.
			// Later exchanges re-read the clear; earlier ones lose their CAS.
			refreshes = settleRefreshes();
		});
	if (!handled) return undefined;
	let result: OAuthRevocationResult = {
		status: targets.length ? "revoked" : "remote_revocation_unconfirmed",
	};
	for (const target of targets) {
		if (!target.refresh) {
			result = { status: "remote_revocation_unconfirmed" };
			continue;
		}
		try {
			const revoked = await revoke(target, options);
			if (revoked.status !== "revoked") result = revoked;
		} catch {
			result = { status: "remote_revocation_unconfirmed" };
		}
	}
	if (!(await refreshes)) result = { status: "remote_revocation_unconfirmed" };
	return result;
}

/**
 * Default in-memory credential store. Apps inject persistent stores.
 * Keyed by `Provider.id`, one entry per provider (possibly a pooled one);
 * see `CredentialStore`.
 * Writes are serialized per provider through a promise chain.
 */
export class InMemoryCredentialStore implements CredentialStore {
	private credentials = new Map<string, Credential>();
	private chains = new Map<string, Promise<unknown>>();

	/** Serialize tasks per provider id without releasing the chain before active work settles. */
	private enqueue<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const signal = operationSignal(options?.signal);
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			return task();
		})();
		const tail = queued.catch(() => {});
		this.chains.set(providerId, tail);
		void tail.then(() => {
			if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
		});
		return raceWithAbortSignal(queued, signal);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.credentials.get(providerId);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.enqueue(
			providerId,
			async () => {
				const current = this.credentials.get(providerId);
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				if (next !== undefined) this.credentials.set(providerId, next);
				return next ?? current;
			},
			options,
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.enqueue(
			providerId,
			async () => {
				this.credentials.delete(providerId);
			},
			options,
		);
	}
}
