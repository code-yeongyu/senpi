import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { listSlots, projectSlot, type PooledCredential } from "./pool/slots.ts";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
	LogoutOptions,
	OAuthAuth,
	OAuthRevocationResult,
} from "./types.ts";

/** Clear session secrets without discarding the registration's non-secret metadata. */
function clearTokens<T extends object>(credential: T) {
	const cleared = { ...credential, access: "", refresh: "", expires: 0, signedOut: true };
	Reflect.deleteProperty(cleared, "idToken");
	return cleared;
}

/** Network work stays outside the store lock; a concurrent new login is never cleared. */
export async function revokeStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	options?: LogoutOptions,
): Promise<OAuthRevocationResult | undefined> {
	const stored: PooledCredential | undefined = await credentials.read(providerId);
	if (stored?.type !== "oauth" || !oauth.revoke) return undefined;
	const slots = listSlots(stored).filter((slot) => options?.slotId === undefined || slot.name === options.slotId);
	let result: OAuthRevocationResult = { status: "revoked" };
	for (const slot of slots) {
		const projected = projectSlot(stored, slot.name);
		if (projected?.type !== "oauth" || !projected.refresh) {
			result = { status: "remote_revocation_unconfirmed" };
			continue;
		}
		try {
			// Provider-owned slot metadata takes precedence over the legacy flat projection.
			const revoked = await oauth.revoke({ ...projected, ...slot }, options);
			if (revoked.status !== "revoked") result = revoked;
		} catch {
			result = { status: "remote_revocation_unconfirmed" };
		}
	}
	// Deliberately not cancellable: even an interrupted remote revoke must clear locally.
	await credentials.modify(providerId, async (current: PooledCredential | undefined) => {
		if (current?.type !== "oauth") return undefined;
		const targets = slots.filter((slot) => {
			const latest = listSlots(current).find((candidate) => candidate.name === slot.name);
			return latest?.refresh === slot.refresh && latest?.access === slot.access;
		});
		if (!targets.length) return undefined;
		const names = new Set(targets.map((slot) => slot.name));
		const accounts = Array.isArray(current.accounts)
			? current.accounts.map((slot) => (names.has(slot.name) ? clearTokens(slot) : slot))
			: undefined;
		let next = targets.some((slot) => slot.refresh === current.refresh && slot.access === current.access)
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
	});
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
