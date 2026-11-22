import { createDecipheriv, createHmac, createPublicKey, diffieHellman, type KeyObject } from "node:crypto";

/**
 * The open half of RFC 9180 base mode, one shot (sequence 0), for the suite decision 0022 pins:
 * DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM (0x0020 / 0x0001 / 0x0002). The engine only opens; the
 * presenter seals. Every refusal is `undefined`, and no input or intermediate value reaches an error or a log.
 */

const KEM_SUITE = Buffer.from([0x4b, 0x45, 0x4d, 0x00, 0x20]);
const HPKE_SUITE = Buffer.from([0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x02]);
const VERSION = Buffer.from("HPKE-v1");
const P = (1n << 255n) - 19n;

/** The five low-order X25519 u-coordinates below p (RFC 7748 section 7 refusals; decision 0003). */
const LOW_ORDER_U = new Set([
	0n,
	1n,
	325606250916557431795983626356110631294008115727848805560023387167927233504n,
	39382357235489614581723060781553021112529911719440698176882885853963445705823n,
	P - 1n,
]);

function extract(salt: Buffer, ikm: Buffer): Buffer {
	return createHmac("sha256", salt.length === 0 ? Buffer.alloc(32) : salt)
		.update(ikm)
		.digest();
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
	const blocks: Buffer[] = [];
	let previous = Buffer.alloc(0);
	for (let i = 1; Buffer.concat(blocks).length < length; i++) {
		previous = createHmac("sha256", prk)
			.update(Buffer.concat([previous, info, Buffer.from([i])]))
			.digest();
		blocks.push(previous);
	}
	return Buffer.concat(blocks).subarray(0, length);
}

function labeledExtract(suite: Buffer, salt: Buffer, label: string, ikm: Buffer): Buffer {
	return extract(salt, Buffer.concat([VERSION, suite, Buffer.from(label), ikm]));
}

function labeledExpand(suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number): Buffer {
	const prefix = Buffer.from([length >> 8, length & 0xff]);
	return expand(prk, Buffer.concat([prefix, VERSION, suite, Buffer.from(label), info]), length);
}

/** A strict X25519 public value: 32 bytes, top bit clear, u < p, not one of the five low-order points. */
function strictX25519(raw: Uint8Array): boolean {
	if (raw.length !== 32 || ((raw[31] ?? 0) & 0x80) !== 0) return false;
	let u = 0n;
	for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(raw[i] ?? 0);
	return u < P && !LOW_ORDER_U.has(u);
}

function x25519Key(raw: Uint8Array): KeyObject {
	return createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") },
		format: "jwk",
	});
}

export interface SecretOpenInput {
	/** The recipient's private key: the request key the engine generated. */
	readonly privateKey: KeyObject;
	/** The recipient's raw public key (`hpkePk`), part of the KEM context. */
	readonly recipientPublicKey: Uint8Array;
	/** The 32-byte encapsulated key (`enc`). */
	readonly enc: Uint8Array;
	/** The AEAD output with its 16-byte tag (`ct`). */
	readonly ct: Uint8Array;
	readonly info: Uint8Array;
	readonly aad: Uint8Array;
}

/** HPKE base-mode open; `undefined` for any refusal (weak `enc`, zero shared secret, or an AEAD failure). */
export function openSecretAnswer(input: SecretOpenInput): Uint8Array | undefined {
	if (!strictX25519(input.enc) || !strictX25519(input.recipientPublicKey) || input.ct.length < 16) return undefined;
	const dh = diffieHellman({ privateKey: input.privateKey, publicKey: x25519Key(input.enc) });
	if (dh.length !== 32 || dh.every((byte) => byte === 0)) return undefined;
	const kemContext = Buffer.concat([input.enc, input.recipientPublicKey]);
	const eaePrk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dh);
	const sharedSecret = labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, 32);
	const pskIdHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0));
	const infoHash = labeledExtract(HPKE_SUITE, Buffer.alloc(0), "info_hash", Buffer.from(input.info));
	const context = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]);
	const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", Buffer.alloc(0));
	const key = labeledExpand(HPKE_SUITE, secret, "key", context, 32);
	const nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12);
	const tag = input.ct.subarray(input.ct.length - 16);
	let plaintext: Buffer | undefined;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce).setAAD(input.aad);
		decipher.setAuthTag(tag);
		// GCM's final() yields no bytes: returning update()'s buffer itself lets the caller zero every plaintext byte.
		plaintext = decipher.update(input.ct.subarray(0, input.ct.length - 16));
		decipher.final();
		return plaintext;
	} catch {
		// An unauthenticated decryption is still near-plaintext for a bit-flipped ciphertext: zero it too.
		plaintext?.fill(0);
		return undefined;
	} finally {
		key.fill(0);
		sharedSecret.fill(0);
		secret.fill(0);
		dh.fill(0);
	}
}
