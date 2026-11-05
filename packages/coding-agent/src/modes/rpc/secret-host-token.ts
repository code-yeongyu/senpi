import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { PresenterAccountAuthority, SecretHostProof } from "./mcp-presenter-account.ts";
import { boundedClaim, presenterKeyThumbprint } from "./mcp-presenter-attestation.ts";

/**
 * Host tokens of the sealed secret route (D11 secret phase, section 3). One in-memory Ed25519 host key per host
 * instance, never persisted; one issuer token per `(hostInstance, durableSessionId)` while a current grant on that
 * session negotiated `secret_input_v1`, re-minted at two thirds of its lifetime and dropped with the last such grant.
 * A request reads the cache synchronously, so secret routing never awaits the issuer.
 */

const HOST_TOKEN_AUDIENCE = "omo-secret-host";
const HOST_TOKEN_TYPE = "secret_host";
/** The issuer's lifetime ceiling and clock skew for a host token (3.2). */
const MAX_LIFETIME_S = 900;
const SKEW_S = 60;
const MAX_TOKEN_CHARS = 8192;
/** A mint that has not settled by then counts as failed; its late result is ignored. */
const MINT_TIMEOUT_MS = 30_000;
/** After a failed mint, while a holder remains: retry within this, sooner when a cached token expires first. */
const RETRY_MAX_MS = 60_000;
const RETRY_MIN_MS = 5_000;

type SecretAuthority = PresenterAccountAuthority &
	Required<Pick<PresenterAccountAuthority, "mintSecretHostToken" | "verifySecretAnswer">>;

/** A host token the engine holds for one session, with the claims it decided on. */
export interface SecretHostToken {
	readonly token: string;
	readonly acc: string;
	/** The minting (host) device; a step-up token's `hdev` must equal it (6.5). */
	readonly dev: string;
	readonly iat: number;
	readonly exp: number;
}

interface Entry {
	readonly binding: McpFormBinding;
	readonly held: () => boolean;
	unsubscribe?: () => void;
	token?: SecretHostToken;
	/** The next re-mint: the two-thirds refresh after a success, the bounded retry after a failure. */
	refresh?: NodeJS.Timeout;
	minting: boolean;
}

function sealedRouteAuthority(authority: PresenterAccountAuthority | undefined): authority is SecretAuthority {
	return typeof authority?.mintSecretHostToken === "function" && typeof authority.verifySecretAnswer === "function";
}

function claimsOf(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
		return isRecord(claims) ? claims : undefined;
	} catch {
		return undefined;
	}
}

export class SecretHostTokens {
	private readonly hostInstance: string;
	private readonly authority: SecretAuthority;
	private readonly privateKey: KeyObject;
	private readonly spki: Buffer;
	private readonly jkt: string;
	private readonly entries = new Map<string, Entry>();
	private disposed = false;

	/** `undefined` unless the authority can both mint host tokens and verify step-up tokens: then no key exists. */
	static create(hostInstance: string, authority: PresenterAccountAuthority | undefined): SecretHostTokens | undefined {
		return sealedRouteAuthority(authority) ? new SecretHostTokens(hostInstance, authority) : undefined;
	}

	private constructor(hostInstance: string, authority: SecretAuthority) {
		this.hostInstance = hostInstance;
		this.authority = authority;
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		this.privateKey = privateKey;
		this.spki = publicKey.export({ type: "spki", format: "der" });
		const jkt = presenterKeyThumbprint(this.spki);
		if (jkt === undefined) throw new Error("secret_host_key_unavailable");
		this.jkt = jkt;
	}

	/**
	 * A grant with `secret_input_v1` was acquired on `binding`. Mints the session's token unless a valid one is held;
	 * `held` reports whether a current account-principal grant on the binding still negotiates the feature.
	 */
	want(durableSessionId: string, binding: McpFormBinding, held: () => boolean): void {
		if (this.disposed || !binding.subscribe || !held()) return;
		let entry = this.entries.get(durableSessionId);
		if (entry && entry.binding !== binding) {
			this.drop(durableSessionId, entry);
			entry = undefined;
		}
		if (!entry) {
			const created: Entry = { binding, held, minting: false };
			created.unsubscribe = binding.subscribe(() => {
				if (!held()) this.drop(durableSessionId, created);
			});
			this.entries.set(durableSessionId, created);
			entry = created;
		}
		if (!entry.minting && (entry.refresh === undefined || !this.valid(entry.token)))
			void this.mint(durableSessionId, entry);
	}

	/** The session's token while it is valid now and still names the signed-in account; read synchronously. */
	current(durableSessionId: string): SecretHostToken | undefined {
		const token = this.entries.get(durableSessionId)?.token;
		return this.valid(token) ? token : undefined;
	}

	private valid(token: SecretHostToken | undefined): token is SecretHostToken {
		return token !== undefined && Date.now() < token.exp * 1000 && token.acc === this.authority.hostAccount();
	}

	dispose(): void {
		this.disposed = true;
		for (const [durableSessionId, entry] of [...this.entries]) this.drop(durableSessionId, entry);
	}

	private async mint(durableSessionId: string, entry: Entry): Promise<void> {
		clearTimeout(entry.refresh);
		entry.refresh = undefined;
		entry.minting = true;
		let open = true;
		const proof = (input: SecretHostProof): string => {
			const { issuer, nonce } = input;
			if (
				!open ||
				typeof issuer !== "string" ||
				typeof nonce !== "string" ||
				!boundedClaim(issuer) ||
				!boundedClaim(nonce)
			)
				throw new Error("secret_host_proof_refused");
			const transcript = [
				"omo-secret-host-proof/v1",
				issuer,
				HOST_TOKEN_AUDIENCE,
				this.jkt,
				nonce,
				this.hostInstance,
				durableSessionId,
			].join("\n");
			return sign(null, Buffer.from(transcript), this.privateKey).toString("base64url");
		};
		let minted: unknown;
		let deadline: NodeJS.Timeout | undefined;
		try {
			if (this.authority.hostAccount() !== undefined) {
				const call = (async () =>
					this.authority.mintSecretHostToken({
						hostInstance: this.hostInstance,
						durableSessionId,
						hostKeySpki: new Uint8Array(this.spki),
						sign: proof,
					}))();
				const timedOut = new Promise<undefined>((resolve) => {
					deadline = setTimeout(() => resolve(undefined), MINT_TIMEOUT_MS);
					deadline.unref();
				});
				// An issuer or authority fault leaves the raiser route only; the key and the session are unaffected.
				minted = await Promise.race([call.catch(() => undefined), timedOut]);
			}
		} finally {
			clearTimeout(deadline);
			open = false;
			entry.minting = false;
		}
		if (this.disposed || this.entries.get(durableSessionId) !== entry) return;
		const token = typeof minted === "string" ? this.accept(minted, durableSessionId) : undefined;
		if (token) {
			entry.token = token;
			this.arm(durableSessionId, entry, ((token.exp * 1000 - Date.now()) * 2) / 3);
			return;
		}
		// While a holder remains, a failure is retried; a still-valid token is kept until its own `exp` (3.2).
		if (!entry.held()) return;
		const left = this.valid(entry.token) ? (entry.token.exp * 1000 - Date.now()) / 3 : RETRY_MAX_MS;
		this.arm(durableSessionId, entry, Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, left)));
	}

	/** The claims the engine relies on, checked against what it asked for; anything else is not this session's token. */
	private accept(token: string, durableSessionId: string): SecretHostToken | undefined {
		if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return undefined;
		const claims = claimsOf(token);
		if (!claims || !isRecord(claims.cnf)) return undefined;
		const { aud, typ, acc, dev, iat, exp, hin, sid } = claims;
		const nowS = Math.floor(Date.now() / 1000);
		if (
			aud !== HOST_TOKEN_AUDIENCE ||
			typ !== HOST_TOKEN_TYPE ||
			hin !== this.hostInstance ||
			sid !== durableSessionId ||
			claims.cnf.jkt !== this.jkt ||
			typeof acc !== "string" ||
			acc !== this.authority.hostAccount() ||
			typeof dev !== "string" ||
			!boundedClaim(dev) ||
			typeof iat !== "number" ||
			typeof exp !== "number" ||
			!Number.isSafeInteger(iat) ||
			!Number.isSafeInteger(exp) ||
			exp <= iat ||
			exp - iat > MAX_LIFETIME_S ||
			iat > nowS + SKEW_S ||
			nowS >= exp
		)
			return undefined;
		return Object.freeze({ token, acc, dev, iat, exp });
	}

	/** Re-mints after `delayMs`, measured on the local clock so issuer clock skew cannot shorten it. */
	private arm(durableSessionId: string, entry: Entry, delayMs: number): void {
		clearTimeout(entry.refresh);
		entry.refresh = setTimeout(
			() => {
				entry.refresh = undefined;
				if (!this.disposed && this.entries.get(durableSessionId) === entry && !entry.minting)
					void this.mint(durableSessionId, entry);
			},
			Math.max(0, delayMs),
		);
		// The host's own lifetime decides when it exits; a pending refresh never holds the process.
		entry.refresh.unref();
	}

	private drop(durableSessionId: string, entry: Entry): void {
		clearTimeout(entry.refresh);
		entry.refresh = undefined;
		entry.token = undefined;
		entry.unsubscribe?.();
		if (this.entries.get(durableSessionId) === entry) this.entries.delete(durableSessionId);
	}
}
