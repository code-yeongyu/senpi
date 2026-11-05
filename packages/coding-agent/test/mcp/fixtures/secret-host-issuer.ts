import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	verify,
	type KeyObject,
} from "node:crypto";
import type {
	PresenterAccountAuthority,
	SecretAnswerRefusal,
	SecretAnswerVerification,
	SecretHostTokenRequest,
} from "../../../src/modes/rpc/mcp-presenter-account.ts";
import { presenterKeyThumbprint } from "../../../src/modes/rpc/mcp-presenter-attestation.ts";
import type { presenterIssuer } from "./presenter-account-issuer.ts";

const ISSUER = "https://account.example";

export interface SecretHostMint {
	readonly request: SecretHostTokenRequest;
	/** The host-key proof verified under `hostKeySpki` over the transcript of design 3.1. */
	readonly proofVerified: boolean;
	readonly claims: Record<string, unknown>;
	/** Settles once the engine has received this mint's result. */
	readonly done: Promise<void>;
}

export interface MintPlan {
	readonly claims?: Record<string, unknown>;
	/** Holds the mint open until `release()`. */
	readonly hold?: boolean;
	readonly fail?: boolean;
	readonly during?: (request: SecretHostTokenRequest) => void;
}

/** The SPKI's raw key in the RFC 7638 OKP thumbprint, from Node's own JWK export (independent of the engine). */
function jkt(spki: Uint8Array): string {
	const { x } = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" }).export({ format: "jwk" });
	return createHash("sha256")
		.update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))
		.digest("base64url");
}

/**
 * The issuer of design 3.1 shaped like the distribution's authority (D11 M-2): a nonce, the host-key proof checked
 * against the request's SPKI, then an ES256 `aud: "omo-secret-host"` token with the claims of 3.2.
 */
export function secretHostIssuer(presenter: ReturnType<typeof presenterIssuer>, lifetimeS = 600) {
	const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const mints: SecretHostMint[] = [];
	const plans: MintPlan[] = [];
	const held: Array<() => void> = [];
	const signToken = (claims: Record<string, unknown>): string => {
		const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "host-1", typ: "JWT" })).toString("base64url");
		const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const signature = sign("sha256", Buffer.from(`${header}.${body}`), {
			key: signing.privateKey,
			dsaEncoding: "ieee-p1363",
		});
		return `${header}.${body}.${signature.toString("base64url")}`;
	};
	const mint = async (host: { account: string | undefined }, request: SecretHostTokenRequest): Promise<string> => {
		const plan = plans.shift() ?? {};
		let finish: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			finish = () => setImmediate(resolve);
		});
		const nonce = randomUUID();
		const transcript = [
			"omo-secret-host-proof/v1",
			ISSUER,
			"omo-secret-host",
			jkt(request.hostKeySpki),
			nonce,
			request.hostInstance,
			request.durableSessionId,
		].join("\n");
		const publicKey = createPublicKey({ key: Buffer.from(request.hostKeySpki), format: "der", type: "spki" });
		const signature = Buffer.from(request.sign({ issuer: ISSUER, nonce }), "base64url");
		const iat = Math.floor(Date.now() / 1000);
		const claims = {
			iss: ISSUER,
			aud: "omo-secret-host",
			typ: "secret_host",
			iat,
			exp: iat + lifetimeS,
			jti: randomUUID(),
			acc: host.account,
			dev: "host-device",
			dname: "Host machine",
			hin: request.hostInstance,
			sid: request.durableSessionId,
			cnf: { jkt: jkt(request.hostKeySpki) },
			...plan.claims,
		};
		mints.push({ request, proofVerified: verify(null, Buffer.from(transcript), publicKey, signature), claims, done });
		plan.during?.(request);
		if (plan.hold) await new Promise<void>((resolve) => held.push(resolve));
		finish();
		if (plan.fail) throw new Error("issuer unavailable");
		return signToken(claims);
	};
	const authority = (host: {
		account: string | undefined;
		readonly listeners?: Set<() => void>;
	}): PresenterAccountAuthority => ({
		...presenter.authority(host),
		mintSecretHostToken: (request) => mint(host, request),
		verifySecretAnswer: async (token, presenterSpki, req, nowS) => verifyStepUp(token, presenterSpki, req, nowS),
	});
	const refused = (reason: SecretAnswerRefusal): SecretAnswerVerification => ({ ok: false, reason });
	/** The 6.5 verifier the distribution would pin: ES256, constants, 120 s lifetime with 60 s skew, uv, cnf, req. */
	const verifyStepUp = (
		token: string,
		presenterSpki: Uint8Array,
		req: string,
		nowS: number,
	): SecretAnswerVerification => {
		const [header, body, signature] = token.split(".");
		let claims: Record<string, unknown>;
		try {
			claims = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8"));
		} catch {
			return refused("stepup_malformed");
		}
		const signed = Buffer.from(`${header}.${body}`);
		if (
			!verify(
				"sha256",
				signed,
				{ key: signing.publicKey, dsaEncoding: "ieee-p1363" },
				Buffer.from(signature ?? "", "base64url"),
			)
		)
			return refused("stepup_signature");
		if (claims.aud !== "omo-secret-answer" || claims.typ !== "secret_answer" || claims.iss !== ISSUER)
			return refused("stepup_audience");
		const { iat, exp, uv, cnf, acc, dev, jti, hdev } = claims;
		if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > 120 || nowS >= exp + 60 || iat > nowS + 60)
			return refused("stepup_expired");
		if (
			uv !== true ||
			typeof cnf !== "object" ||
			cnf === null ||
			Reflect.get(cnf, "jkt") !== presenterKeyThumbprint(presenterSpki)
		)
			return refused("stepup_key_mismatch");
		if (claims.req !== req) return refused("stepup_binding");
		if (typeof acc !== "string" || typeof dev !== "string" || typeof jti !== "string" || typeof hdev !== "string")
			return refused("stepup_malformed");
		return { ok: true, stepUp: { acc, dev, jti, exp, hdev } };
	};
	/** An issuer step-up token for a presenter key and a request (6.4 step 4), with claim overrides for the refusals. */
	const stepUp = (presenterKey: KeyObject, req: string, claims: Record<string, unknown> = {}): string => {
		const iat = Math.floor(Date.now() / 1000);
		return signToken({
			iss: ISSUER,
			aud: "omo-secret-answer",
			typ: "secret_answer",
			iat,
			exp: iat + 120,
			jti: randomUUID(),
			acc: "account-a",
			dev: "device-phone",
			cnf: { jkt: presenterKeyThumbprint(presenterKey.export({ type: "spki", format: "der" })) },
			req,
			hdev: "host-device",
			uv: true,
			cred: "credential-hash",
			...claims,
		});
	};
	return {
		stepUp,
		authority,
		mints,
		plan: (next: MintPlan) => plans.push(next),
		release: () => held.shift()?.(),
	};
}
