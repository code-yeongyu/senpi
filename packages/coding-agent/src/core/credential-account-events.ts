/** Secret-free updates that can be forwarded through the existing session event stream. */
export type CredentialAccountUpdate =
	| {
			readonly type: "credential_accounts_changed";
			readonly provider: string;
			readonly reason: "credentials" | "health";
	  }
	| { readonly type: "credential_account_attempt"; readonly provider: string; readonly name?: string };

/** Scope is process-local identity, never forwarded to clients. */
type ScopedUpdate = {
	readonly scope: object | string;
	readonly sessionId?: string;
	readonly update: CredentialAccountUpdate;
};
const listeners = new Set<(event: ScopedUpdate) => void>();

export function subscribeCredentialAccountUpdates(listener: (event: ScopedUpdate) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function emitCredentialAccountUpdate(event: ScopedUpdate): void {
	for (const listener of listeners) listener(event);
}
