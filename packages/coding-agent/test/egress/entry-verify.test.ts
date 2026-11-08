import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENTRY_SIG_DOMAIN, entrySigPayload, verifyEntrySig } from "../../src/core/egress/entry-verify.ts";

const DIGEST = "3b7f0c2a9e4d1f6b8a0c5e7d9f1b3a5c7e9d0b2f4a6c8e0d1f3b5a7c9e1d2f4a";

function owner() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
	return { privateKey, raw };
}

function signPayload(privateKey: ReturnType<typeof owner>["privateKey"], payload: Uint8Array): string {
	return sign(null, payload, privateKey).toString("base64url");
}

describe("entrySig payload", () => {
	it("is ASCII(domain) || 0x00 || ASCII(entryDigest)", () => {
		const payload = entrySigPayload(DIGEST);
		const expected = Buffer.concat([
			Buffer.from(ENTRY_SIG_DOMAIN, "ascii"),
			Buffer.from([0]),
			Buffer.from(DIGEST, "ascii"),
		]);
		expect(Buffer.from(payload).equals(expected)).toBe(true);
		expect(ENTRY_SIG_DOMAIN).toBe("omo-custody/provider-entry/v1");
	});

	it.each(["", "ABCDEF", "3b7f 0c", "z".repeat(64), "3b7f\u00e9"])(
		"refuses a digest that is not lowercase hex: %j",
		(digest) => {
			expect(() => entrySigPayload(digest)).toThrow();
		},
	);
});

describe("verifyEntrySig", () => {
	it("accepts the owner's Ed25519 signature over the domain-tagged digest", async () => {
		const { privateKey, raw } = owner();
		const entrySig = signPayload(privateKey, entrySigPayload(DIGEST));
		await expect(verifyEntrySig({ entryDigest: DIGEST, entrySig, ownerPublicKey: raw })).resolves.toBe(true);
	});

	it("refuses a signature over the bare digest (no domain tag)", async () => {
		const { privateKey, raw } = owner();
		const entrySig = signPayload(privateKey, Buffer.from(DIGEST, "ascii"));
		await expect(verifyEntrySig({ entryDigest: DIGEST, entrySig, ownerPublicKey: raw })).resolves.toBe(false);
	});

	it("refuses a signature made under another type's domain tag", async () => {
		const { privateKey, raw } = owner();
		const other = Buffer.concat([
			Buffer.from("omo-custody/wrap-submission/v1"),
			Buffer.from([0]),
			Buffer.from(DIGEST),
		]);
		const entrySig = signPayload(privateKey, other);
		await expect(verifyEntrySig({ entryDigest: DIGEST, entrySig, ownerPublicKey: raw })).resolves.toBe(false);
	});

	it("refuses a moved entry: the signature does not carry over to another digest", async () => {
		const { privateKey, raw } = owner();
		const entrySig = signPayload(privateKey, entrySigPayload(DIGEST));
		const moved = `${DIGEST.slice(0, -1)}b`;
		await expect(verifyEntrySig({ entryDigest: moved, entrySig, ownerPublicKey: raw })).resolves.toBe(false);
	});

	it("refuses another device's key", async () => {
		const signer = owner();
		const stranger = owner();
		const entrySig = signPayload(signer.privateKey, entrySigPayload(DIGEST));
		await expect(verifyEntrySig({ entryDigest: DIGEST, entrySig, ownerPublicKey: stranger.raw })).resolves.toBe(
			false,
		);
	});

	it.each([
		["padded base64url", (sig: string) => `${sig}==`],
		["standard base64", (sig: string) => sig.replaceAll("-", "+").replaceAll("_", "/")],
		["truncated", (sig: string) => sig.slice(0, -2)],
		["empty", () => ""],
	])("refuses a %s signature encoding", async (_label, mangle) => {
		const { privateKey, raw } = owner();
		const entrySig = mangle(signPayload(privateKey, entrySigPayload(DIGEST)));
		await expect(verifyEntrySig({ entryDigest: DIGEST, entrySig, ownerPublicKey: raw })).resolves.toBe(false);
	});

	it("refuses an owner key that is not 32 bytes", async () => {
		const { privateKey } = owner();
		const entrySig = signPayload(privateKey, entrySigPayload(DIGEST));
		await expect(verifyEntrySig({ entryDigest: DIGEST, entrySig, ownerPublicKey: new Uint8Array(31) })).resolves.toBe(
			false,
		);
	});
});
