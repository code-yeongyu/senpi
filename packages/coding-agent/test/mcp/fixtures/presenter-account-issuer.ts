import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	verify,
	type KeyObject,
} from "node:crypto";
import { isRecord } from "../../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import { presenterKeyThumbprint } from "../../../src/modes/rpc/mcp-presenter-attestation.ts";
import {
	type PresenterAccountAuthority,
	type PresenterAttestationRefusal,
	type PresenterAttestationResult,
} from "../../../src/modes/rpc/mcp-presenter-account.ts";

const ISSUER = "https://account.example";

/** The RFC 7638 OKP thumbprint, computed from Node's JWK export: an oracle independent of the engine helper. */
export function jwkThumbprint(key: KeyObject): string {
	const { x } = key.export({ format: "jwk" });
	return createHash("sha256")
		.update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))
		.digest("base64url");
}

function refused(reason: PresenterAttestationRefusal): PresenterAttestationResult {
	return { ok: false, reason };
}

function decode(part: string | undefined): unknown {
	return part === undefined ? undefined : JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * A real ES256 issuer and a verifier pinned to its JWKS, shaped like the distribution's authority (D11 M-1):
 * signature, `iss`, `aud`/`typ` constants, lifetime with 60 s skew, and `cnf.jkt` against the engine's thumbprint.
 */
export function presenterIssuer() {
	const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwks = new Map([
		["presenter-1", createPublicKey({ key: signing.publicKey.export({ format: "jwk" }), format: "jwk" })],
	]);
	let verified = 0;
	const mint = (
		installationKey: KeyObject,
		claims: Record<string, unknown> = {},
		signer: KeyObject = signing.privateKey,
	): string => {
		const iat = Math.floor(Date.now() / 1000);
		const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "presenter-1", typ: "JWT" })).toString(
			"base64url",
		);
		const body = Buffer.from(
			JSON.stringify({
				iss: ISSUER,
				aud: "omo-mcp-presenter",
				typ: "mcp_presenter",
				acc: "account-a",
				dev: "device-a",
				dname: "Work laptop",
				jti: randomUUID(),
				iat,
				exp: iat + 600,
				cnf: { jkt: jwkThumbprint(installationKey) },
				...claims,
			}),
		).toString("base64url");
		const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: signer, dsaEncoding: "ieee-p1363" });
		return `${header}.${body}.${signature.toString("base64url")}`;
	};
	const authority = (host: {
		account: string | undefined;
		readonly listeners?: Set<() => void>;
	}): PresenterAccountAuthority => ({
		hostAccount: () => host.account,
		onAccountChange: (listener) => {
			host.listeners?.add(listener);
			return () => host.listeners?.delete(listener);
		},
		verify: async (token, publicKeySpkiDer, nowS) => {
			verified++;
			const parts = token.split(".");
			let header: unknown;
			let claims: unknown;
			try {
				header = decode(parts[0]);
				claims = decode(parts[1]);
			} catch {
				return refused("attestation_malformed");
			}
			if (parts.length !== 3 || !isRecord(header) || !isRecord(claims) || header.alg !== "ES256")
				return refused("attestation_malformed");
			const key = typeof header.kid === "string" ? jwks.get(header.kid) : undefined;
			const signature = Buffer.from(parts[2] ?? "", "base64url");
			const data = Buffer.from(`${parts[0]}.${parts[1]}`);
			if (!key || !verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature))
				return refused("attestation_signature");
			if (claims.iss !== ISSUER || claims.aud !== "omo-mcp-presenter" || claims.typ !== "mcp_presenter")
				return refused("attestation_audience");
			const { iat, exp, acc, dev, dname, jti, cnf } = claims;
			if (typeof iat !== "number" || typeof exp !== "number") return refused("attestation_malformed");
			if (exp - iat > 900 || iat > nowS + 60 || nowS >= exp + 60) return refused("attestation_expired");
			if (!isRecord(cnf) || cnf.jkt !== presenterKeyThumbprint(publicKeySpkiDer))
				return refused("attestation_key_mismatch");
			if (typeof acc !== "string" || typeof dev !== "string" || typeof dname !== "string" || typeof jti !== "string")
				return refused("attestation_malformed");
			return { ok: true, attestation: { acc, dev, dname, exp, jti } };
		},
	});
	return { mint, authority, verifications: () => verified };
}
