import { describe, expect, it } from "vitest";
import {
	hpkeDecap,
	hpkeEncapDeterministic,
	hpkeKeySchedule,
	hpkeOpenBase,
	hpkeSealBase,
	p256Recipient,
	SealedFormatError,
} from "../../src/core/egress/hpke.ts";

const hex = (value: string): Uint8Array =>
	Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// CFRG draft-irtf-cfrg-hpke test-vectors.json, the single entry with mode 0, kem 0x0010, kdf 0x0001, aead 0x0002
// (DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM), pinned byte-for-byte; sequence 0 only (single-shot).
const KAT = {
	info: "4f6465206f6e2061204772656369616e2055726e",
	skEm: "90345e3a1d116c1dd39ae76d95ab858c142223a63e44f8f85318cfa91a84858e",
	pkEm: "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
	skRm: "317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2",
	pkRm: "04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c",
	enc: "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
	sharedSecret: "48893fecd82f7c3456af6a42d8f56325d21e08c10fa81299986aaff54cde7b49",
	key: "ee16802a936d5f544771131900ee6973d0551de9e852ece2ef34bf0d5f9e1d1d",
	baseNonce: "9bc50980832a7b4b58c40161",
	aad: "436f756e742d30",
	ct: "58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f",
	pt: "4265617574792069732074727574682c20747275746820626561757479",
} as const;

const katRecipient = () => p256Recipient(hex(KAT.skRm), hex(KAT.pkRm));

async function rejectsWithOpenFailed(promise: Promise<unknown>): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(SealedFormatError);
	expect((error as SealedFormatError).code).toBe("open_failed");
}

describe("HPKE base mode, DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM (RFC 9180)", () => {
	it("decapsulates the CFRG vector to its shared secret", async () => {
		const recipient = await katRecipient();
		expect(toHex(await hpkeDecap(recipient, hex(KAT.enc)))).toBe(KAT.sharedSecret);
	});

	it("encapsulates the CFRG vector's ephemeral key to the same enc and shared secret", async () => {
		const { enc, sharedSecret } = await hpkeEncapDeterministic(hex(KAT.pkRm), hex(KAT.skEm), hex(KAT.pkEm));
		expect(toHex(enc)).toBe(KAT.enc);
		expect(toHex(sharedSecret)).toBe(KAT.sharedSecret);
	});

	it("derives the CFRG vector's key and base nonce from the shared secret and info", async () => {
		const { key, baseNonce } = await hpkeKeySchedule(hex(KAT.sharedSecret), hex(KAT.info));
		expect(toHex(key)).toBe(KAT.key);
		expect(toHex(baseNonce)).toBe(KAT.baseNonce);
	});

	it("opens the CFRG vector's sequence-0 ciphertext", async () => {
		const plaintext = await hpkeOpenBase(await katRecipient(), {
			enc: hex(KAT.enc),
			ct: hex(KAT.ct),
			info: hex(KAT.info),
			aad: hex(KAT.aad),
		});
		expect(toHex(plaintext)).toBe(KAT.pt);
	});

	it("seals to a recipient with a fresh ephemeral key that only that recipient opens", async () => {
		const pt = new TextEncoder().encode("sk-test-not-a-real-key");
		const info = new TextEncoder().encode("info");
		const aad = new TextEncoder().encode("aad");
		const first = await hpkeSealBase(hex(KAT.pkRm), { info, aad, pt });
		const second = await hpkeSealBase(hex(KAT.pkRm), { info, aad, pt });
		expect(first.enc).toHaveLength(65);
		expect(first.enc[0]).toBe(0x04);
		expect(first.ct).toHaveLength(pt.length + 16);
		expect(toHex(first.enc)).not.toBe(toHex(second.enc));
		const opened = await hpkeOpenBase(await katRecipient(), { enc: first.enc, ct: first.ct, info, aad });
		expect(new TextDecoder().decode(opened)).toBe("sk-test-not-a-real-key");
	});

	describe("refuses to open", () => {
		const base = () => ({ enc: hex(KAT.enc), ct: hex(KAT.ct), info: hex(KAT.info), aad: hex(KAT.aad) });

		it("under a tampered aad", async () => {
			const aad = hex(KAT.aad);
			aad[0] ^= 0x01;
			await rejectsWithOpenFailed(hpkeOpenBase(await katRecipient(), { ...base(), aad }));
		});

		it("under a different info", async () => {
			await rejectsWithOpenFailed(hpkeOpenBase(await katRecipient(), { ...base(), info: new Uint8Array() }));
		});

		it("with the wrong recipient key", async () => {
			const wrong = await p256Recipient(hex(KAT.skEm), hex(KAT.pkEm));
			await rejectsWithOpenFailed(hpkeOpenBase(wrong, base()));
		});

		it("a truncated ciphertext", async () => {
			const ct = hex(KAT.ct);
			await rejectsWithOpenFailed(
				hpkeOpenBase(await katRecipient(), { ...base(), ct: ct.subarray(0, ct.length - 1) }),
			);
			await rejectsWithOpenFailed(hpkeOpenBase(await katRecipient(), { ...base(), ct: ct.subarray(0, 15) }));
		});

		it("a flipped ciphertext bit", async () => {
			const ct = hex(KAT.ct);
			ct[3] ^= 0x80;
			await rejectsWithOpenFailed(hpkeOpenBase(await katRecipient(), { ...base(), ct }));
		});

		it("an enc that is not an uncompressed P-256 point", async () => {
			const enc = hex(KAT.enc);
			await rejectsWithOpenFailed(hpkeOpenBase(await katRecipient(), { ...base(), enc: enc.subarray(0, 33) }));
			const offCurve = hex(KAT.enc);
			offCurve[64] ^= 0x01;
			await rejectsWithOpenFailed(hpkeOpenBase(await katRecipient(), { ...base(), enc: offCurve }));
		});
	});
});
