/**
 * Same-account presenter enrollment (senpi#4249, D11). The engine knows no omo account; the distribution that
 * launches the host injects this authority at host start. It is never reachable from an RPC command, argument,
 * environment variable, settings file, or session state. Without it, account enrollment fails closed.
 */

/** Why an attestation was refused. Account mismatch and `jti` replay are decided by the host, not here. */
export type PresenterAttestationRefusal =
	| "attestation_malformed"
	| "attestation_signature"
	| "attestation_audience"
	| "attestation_expired"
	| "attestation_key_mismatch";

/** The verified claims of an `aud: "omo-mcp-presenter"`, `typ: "mcp_presenter"` token. */
export interface PresenterAttestation {
	readonly acc: string;
	readonly dev: string;
	/** The account's device name; display data only, never used for decisions. */
	readonly dname: string;
	/** JWT `exp`, in seconds since the epoch. */
	readonly exp: number;
	readonly jti: string;
}

export type PresenterAttestationResult =
	| { readonly ok: true; readonly attestation: PresenterAttestation }
	| { readonly ok: false; readonly reason: PresenterAttestationRefusal };

export interface PresenterAccountAuthority {
	/** The account this host's installation is signed in as, re-read on every call; `undefined` when signed out. */
	hostAccount(): string | undefined;
	/**
	 * Checks the issuer signature against the pinned JWKS, `iss`, `aud`/`typ` (code constants), the lifetime, and
	 * that `cnf.jkt` is the RFC 7638 OKP thumbprint of `publicKeySpkiDer`.
	 */
	verify(token: string, publicKeySpkiDer: Uint8Array, nowS: number): Promise<PresenterAttestationResult>;
	/** Fires on sign-out or an account switch; returns the unsubscribe function. */
	onAccountChange(listener: () => void): () => void;
}
