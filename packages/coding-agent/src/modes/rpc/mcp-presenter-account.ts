import { randomBytes, randomUUID, type KeyObject } from "node:crypto";
import type { Duplex } from "node:stream";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import {
	accountEnrollmentTranscript,
	parseAccountEnrollment,
	type AccountEnrollment,
} from "./mcp-presenter-enrollment.ts";
import { accountLapse, AttestationExpiry } from "./mcp-presenter-account-lifetime.ts";
import { boundedClaim, PresenterJtiCache } from "./mcp-presenter-attestation.ts";
import { send, signed } from "./mcp-presenter-wire.ts";

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
	 * that `cnf.jkt` is `presenterKeyThumbprint(publicKeySpkiDer)`.
	 */
	verify(token: string, publicKeySpkiDer: Uint8Array, nowS: number): Promise<PresenterAttestationResult>;
	/** Fires on sign-out or an account switch; returns the unsubscribe function. */
	onAccountChange(listener: () => void): () => void;
}

export type PresenterAccountRefusal =
	| PresenterAttestationRefusal
	| "attestation_replayed"
	| "presenter_account_unavailable"
	| "presenter_account_mismatch"
	| "presenter_busy"
	| "presenter_proof_invalid";

/** A presenter admitted by a same-account attestation. Never a launch owner; in memory only. */
export interface AccountPrincipal {
	readonly kind: "account";
	readonly id: string;
	readonly key: KeyObject;
	readonly acc: string;
	readonly dev: string;
	readonly dname: string;
	readonly installationKeyId: string;
	/** The current attestation's `exp`, in seconds since the epoch. */
	attestedUntil: number;
	/** The control stream it enrolled on: its only management stream. */
	readonly stream: Duplex;
	readonly sessions: WeakSet<McpFormBinding>;
}

interface Attempt {
	readonly request: AccountEnrollment;
	readonly attestation: PresenterAttestation;
	readonly transcript: string;
}

function refuse(stream: Duplex, reason: PresenterAccountRefusal): void {
	stream.end(`${JSON.stringify({ type: "account_refused", version: 1, reason })}\n`, () => stream.destroy());
}

/**
 * `account_enroll` and `account_reattest` on the presenter control endpoint (D11 S3-2). The pre-auth exchange is one
 * attempt within the control connection's 30 s window: attestation, then a signature over the host's transcript.
 */
export class McpPresenterAccounts {
	private readonly hostInstance: string;
	private readonly principals: Map<string, AccountPrincipal | { readonly kind: "inherited" }>;
	private readonly authority: PresenterAccountAuthority | undefined;
	private readonly revokeStream: (stream: Duplex) => void;
	private readonly jtis = new PresenterJtiCache();
	private readonly attempts = new WeakMap<Duplex, Attempt>();
	private readonly started = new WeakSet<Duplex>();
	private readonly verifying = new WeakSet<Duplex>();
	private readonly closing = new WeakSet<Duplex>();
	private readonly expiry = new AttestationExpiry();
	private readonly unsubscribe: (() => void) | undefined;

	constructor(
		hostInstance: string,
		principals: Map<string, AccountPrincipal | { readonly kind: "inherited" }>,
		authority: PresenterAccountAuthority | undefined,
		revokeStream: (stream: Duplex) => void,
	) {
		this.hostInstance = hostInstance;
		this.principals = principals;
		this.authority = authority;
		this.revokeStream = revokeStream;
		// A sign-out or account switch ends every account principal now (D11 S3-4).
		this.unsubscribe = authority?.onAccountChange(() => {
			for (const principal of [...this.principals.values()])
				if (principal.kind === "account")
					this.revoke(principal, accountLapse(principal, this.authority) ?? "presenter_account_mismatch");
		});
	}

	/** Takes account frames; `fresh` is a control stream that has sent nothing else. False leaves the frame alone. */
	receive(stream: Duplex, value: Record<string, unknown>, fresh: boolean, authenticated: () => void): boolean {
		if (this.closing.has(stream)) return true;
		if (this.verifying.has(stream)) {
			stream.destroy();
			return true;
		}
		const attempt = this.attempts.get(stream);
		if (attempt) {
			this.attempts.delete(stream);
			this.prove(stream, value, attempt, authenticated);
			return true;
		}
		if (value.type === "account_enroll") {
			if (!fresh || this.started.has(stream)) stream.destroy();
			else void this.enroll(stream, value);
			return true;
		}
		if (value.type !== "account_reattest") return false;
		const principal = this.principalOn(stream);
		if (!principal || Object.keys(value).length !== 2 || typeof value.attestation !== "string") stream.destroy();
		else void this.reattest(stream, principal, value.attestation);
		return true;
	}

	/** Revokes an account principal whose host account or attestation is no longer current; true when it did. */
	lapsed(principal: AccountPrincipal | { readonly kind: "inherited" }): boolean {
		if (principal.kind !== "account") return false;
		const reason = accountLapse(principal, this.authority);
		if (reason !== undefined) this.revoke(principal, reason);
		return reason !== undefined;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.expiry.dispose();
		this.jtis.clear();
	}

	private async enroll(stream: Duplex, value: Record<string, unknown>): Promise<void> {
		this.started.add(stream);
		const request = parseAccountEnrollment(value);
		if (!request) return void stream.destroy();
		this.verifying.add(stream);
		const attested = await this.attest(stream, request.attestation, request.key);
		this.verifying.delete(stream);
		if (attested === undefined) return;
		if (typeof attested === "string") return this.refuse(stream, attested);
		const transcript = accountEnrollmentTranscript(
			this.hostInstance,
			attested.acc,
			attested,
			request.installationKeyId,
			randomBytes(32).toString("hex"),
		);
		this.attempts.set(stream, { request, attestation: attested, transcript });
		send(stream, { type: "challenge", version: 1, transcript, hostInstance: this.hostInstance });
	}

	private prove(stream: Duplex, value: Record<string, unknown>, attempt: Attempt, authenticated: () => void): void {
		const { request, attestation } = attempt;
		if (!signed(value, attempt.transcript, request.key)) return this.refuse(stream, "presenter_proof_invalid");
		if (this.authority?.hostAccount() !== attestation.acc) return this.refuse(stream, "presenter_account_mismatch");
		for (const old of this.principals.values()) {
			if (
				old.kind === "account" &&
				old.acc === attestation.acc &&
				old.dev === attestation.dev &&
				old.installationKeyId === request.installationKeyId
			)
				this.revoke(old);
		}
		const principal: AccountPrincipal = {
			kind: "account",
			id: randomUUID(),
			key: request.key,
			acc: attestation.acc,
			dev: attestation.dev,
			dname: attestation.dname,
			installationKeyId: request.installationKeyId,
			attestedUntil: attestation.exp,
			stream,
			sessions: new WeakSet(),
		};
		this.principals.set(principal.id, principal);
		this.expireAt(principal);
		stream.once("close", () => {
			this.expiry.clear(principal);
			if (this.principals.get(principal.id) === principal) this.principals.delete(principal.id);
		});
		authenticated();
		send(stream, {
			type: "account_enrolled",
			version: 1,
			principalId: principal.id,
			hostInstance: this.hostInstance,
			attestedUntil: principal.attestedUntil,
		});
	}

	private async reattest(stream: Duplex, principal: AccountPrincipal, token: string): Promise<void> {
		let attested = await this.attest(stream, token, principal.key);
		if (attested === undefined || this.principals.get(principal.id) !== principal) return;
		if (typeof attested !== "string" && attested.acc !== principal.acc) attested = "presenter_account_mismatch";
		if (typeof attested !== "string") {
			principal.attestedUntil = attested.exp;
			this.expireAt(principal);
			return send(stream, { type: "account_reattested", version: 1, attestedUntil: attested.exp });
		}
		if (
			attested === "attestation_key_mismatch" ||
			attested === "presenter_account_mismatch" ||
			attested === "presenter_account_unavailable"
		)
			return this.revoke(principal, attested);
		send(stream, { type: "account_refused", version: 1, reason: attested });
	}

	private async attest(
		stream: Duplex,
		token: string,
		key: KeyObject,
	): Promise<PresenterAttestation | PresenterAccountRefusal | undefined> {
		const authority = this.authority;
		if (!authority || authority.hostAccount() === undefined) return "presenter_account_unavailable";
		const nowS = Math.floor(Date.now() / 1000);
		let result: PresenterAttestationResult;
		try {
			result = await authority.verify(token, key.export({ type: "spki", format: "der" }), nowS);
		} catch {
			// A verifier fault is not the client's refusal: fail closed without a reason.
			stream.destroy();
			return undefined;
		}
		if (stream.destroyed) return undefined;
		if (!result.ok) return result.reason;
		const { attestation } = result;
		if (
			![attestation.dev, attestation.dname, attestation.jti].every(boundedClaim) ||
			!Number.isSafeInteger(attestation.exp) ||
			attestation.exp > nowS + 960
		)
			return "attestation_malformed";
		const hostAccount = authority.hostAccount();
		if (hostAccount === undefined) return "presenter_account_unavailable";
		if (attestation.acc !== hostAccount) return "presenter_account_mismatch";
		const admitted = this.jtis.admit(attestation.jti, attestation.exp, nowS);
		return admitted === "ok" ? attestation : admitted;
	}

	private expireAt(principal: AccountPrincipal): void {
		this.expiry.arm(principal, () => {
			if (this.principals.get(principal.id) === principal) this.revoke(principal, "attestation_expired");
		});
	}

	private principalOn(stream: Duplex): AccountPrincipal | undefined {
		for (const principal of this.principals.values())
			if (principal.kind === "account" && principal.stream === stream) return principal;
		return undefined;
	}

	/** Revokes the principal's registrations now, then closes its stream: with the refusal flushed, if one is given. */
	private revoke(principal: AccountPrincipal, reason?: PresenterAccountRefusal): void {
		this.expiry.clear(principal);
		this.principals.delete(principal.id);
		this.revokeStream(principal.stream);
		if (reason) this.refuse(principal.stream, reason);
		else principal.stream.destroy();
	}

	private refuse(stream: Duplex, reason: PresenterAccountRefusal): void {
		this.closing.add(stream);
		refuse(stream, reason);
	}
}
