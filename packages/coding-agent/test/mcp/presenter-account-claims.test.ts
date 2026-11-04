import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { PresenterJtiCache, presenterKeyThumbprint } from "../../src/modes/rpc/mcp-presenter-account.ts";
import { jwkThumbprint } from "./fixtures/presenter-account-issuer.ts";
import vectors from "./fixtures/presenter-jkt-vectors.json" with { type: "json" };

const spki = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" });

it.each(vectors)("the SPKI -> jkt conformance vector holds: $source", ({ spkiPem, jkt }) => {
	expect(presenterKeyThumbprint(spki(spkiPem))).toBe(jkt);
});

it("the thumbprint of a fresh Ed25519 key equals the OKP JWK thumbprint of the same key", () => {
	const { publicKey } = generateKeyPairSync("ed25519");
	expect(presenterKeyThumbprint(publicKey.export({ type: "spki", format: "der" }))).toBe(jwkThumbprint(publicKey));
});

it.each([
	["an X25519 key", () => generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" })],
	[
		"a P-256 key",
		() => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }),
	],
	["a truncated Ed25519 SPKI", () => spki(vectors[0]?.spkiPem ?? "").subarray(0, 43)],
	["a padded Ed25519 SPKI", () => Buffer.concat([spki(vectors[0]?.spkiPem ?? ""), Buffer.from([0])])],
])("%s has no thumbprint", (_name, der) => {
	expect(presenterKeyThumbprint(der())).toBeUndefined();
});

it("the jti cache refuses at its cap instead of evicting, and forgets an entry only after exp plus the 60 s skew", () => {
	const cache = new PresenterJtiCache(2);
	expect(cache.admit("a", 100, 0)).toBe("ok");
	expect(cache.admit("a", 100, 0)).toBe("attestation_replayed");
	expect(cache.admit("b", 500, 0)).toBe("ok");
	expect(cache.admit("c", 500, 0)).toBe("presenter_busy");
	expect(cache.admit("a", 100, 159)).toBe("attestation_replayed");
	expect(cache.admit("c", 500, 160)).toBe("ok");
	expect(cache.admit("a", 100, 160)).toBe("presenter_busy");
	expect(cache.admit("b", 500, 160)).toBe("attestation_replayed");
});
