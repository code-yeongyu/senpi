import { createHash } from "node:crypto";

/** Host-side checks of a presenter attestation (D11 S3-2): the key binding, single use, and claim bounds. */

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * RFC 7638/8037 thumbprint of an Ed25519 SPKI DER key: the raw 32 bytes after the fixed 12-byte prefix, as the OKP
 * JWK `{"crv":"Ed25519","kty":"OKP","x":…}`, SHA-256, base64url. `undefined` for any other key or encoding.
 */
export function presenterKeyThumbprint(spkiDer: Uint8Array): string | undefined {
	const der = Buffer.from(spkiDer);
	if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) return undefined;
	const x = der.subarray(12).toString("base64url");
	return createHash("sha256")
		.update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))
		.digest("base64url");
}

/**
 * Single-use `jti`s of one host incarnation. An entry is kept until its `exp` plus the issuer's 60 s skew, the last
 * moment the verifier still accepts the token. A full cache refuses instead of evicting: eviction reopens replay.
 */
export class PresenterJtiCache {
	private readonly seen = new Map<string, number>();
	private readonly cap: number;

	constructor(cap = 4096) {
		this.cap = cap;
	}

	admit(jti: string, exp: number, nowS: number): "ok" | "attestation_replayed" | "presenter_busy" {
		for (const [id, until] of this.seen) if (until <= nowS) this.seen.delete(id);
		if (this.seen.has(jti)) return "attestation_replayed";
		if (this.seen.size >= this.cap) return "presenter_busy";
		this.seen.set(jti, exp + 60);
		return "ok";
	}

	clear(): void {
		this.seen.clear();
	}
}

/** Display and cache inputs from the issuer: non-empty, at most 256 characters, no control characters. */
export function boundedClaim(value: string): boolean {
	return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}
