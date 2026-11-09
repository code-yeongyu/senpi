/**
 * HPKE base mode (RFC 9180): DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, on Web Crypto only so the same code
 * runs on Bun, Node, compiled binaries, the desktop renderer and Workers. Every wrap is single-shot (sequence 0).
 *
 * The recipient side takes a Diffie-Hellman function instead of a private key, so a recipient whose key never leaves
 * hardware (a KMS key that only performs ECDH) opens wraps through the same code as a device key.
 *
 * Base mode authenticates nothing about the sender: anyone holding a recipient public key can produce a wrap that opens.
 * A successful open proves only that the wrap was made for this key, so origin is established above this layer
 * (signed wraps documents, per-dekId owners), never by an open.
 */

const HPKE_V1 = "HPKE-v1";
const KEM_ID = 0x0010; // DHKEM(P-256, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0002; // AES-256-GCM
const MODE_BASE = 0x00;

const N_SECRET = 32;
const N_DH = 32;
const N_K = 32;
const N_N = 12;
const N_T = 16;
const N_PK = 65;
const HASH_LEN = 32;

export type SealedFormatErrorCode =
	| "open_failed"
	| "unsupported_version"
	| "invalid_public_key"
	| "invalid_private_key"
	| "invalid_key"
	| "invalid_aad"
	| "empty_secret";

/** Errors carry a code only: no key material, ciphertext or plaintext is ever echoed. */
export class SealedFormatError extends Error {
	readonly code: SealedFormatErrorCode;
	constructor(code: SealedFormatErrorCode) {
		super(`sealed format: ${code}`);
		this.name = "SealedFormatError";
		this.code = code;
	}
}

/** A P-256 HPKE recipient. `dh` returns the 32-byte x-coordinate of the ECDH shared point with `peer`. */
export interface HpkeRecipient {
	/** Uncompressed SEC1 encoding (65 bytes, leading 0x04). */
	readonly publicKey: Uint8Array;
	dh(peer: Uint8Array): Promise<Uint8Array>;
}

export interface HpkeSealInput {
	readonly info: Uint8Array;
	readonly aad: Uint8Array;
	readonly pt: Uint8Array;
}

export interface HpkeOpenInput {
	readonly enc: Uint8Array;
	readonly ct: Uint8Array;
	readonly info: Uint8Array;
	readonly aad: Uint8Array;
}

export interface HpkeSealed {
	readonly enc: Uint8Array;
	readonly ct: Uint8Array;
}

const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

const own = (view: Uint8Array): Bytes => Uint8Array.from(view);

function i2osp(value: number, length: number): Bytes {
	const out = new Uint8Array(length);
	for (let index = length - 1, rest = value; index >= 0; index--, rest = Math.floor(rest / 256))
		out[index] = rest & 0xff;
	return out;
}

function concat(...parts: readonly Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function kemSuiteId(): Bytes {
	return concat(encoder.encode("KEM"), i2osp(KEM_ID, 2));
}

function hpkeSuiteId(): Bytes {
	return concat(encoder.encode("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
}

async function hmacSha256(key: Bytes, data: Bytes): Promise<Bytes> {
	const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, data));
}

// RFC 5869: an absent salt is HashLen zero bytes.
async function hkdfExtract(salt: Uint8Array, ikm: Bytes): Promise<Bytes> {
	return hmacSha256(salt.length === 0 ? new Uint8Array(HASH_LEN) : own(salt), ikm);
}

async function hkdfExpand(prk: Bytes, info: Bytes, length: number): Promise<Bytes> {
	const out = new Uint8Array(length);
	let previous: Bytes = new Uint8Array();
	for (let block = 1, offset = 0; offset < length; block++) {
		previous = await hmacSha256(prk, concat(previous, info, Uint8Array.of(block)));
		out.set(previous.subarray(0, Math.min(previous.length, length - offset)), offset);
		offset += previous.length;
	}
	return out;
}

function labeledExtract(suiteId: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Promise<Bytes> {
	return hkdfExtract(salt, concat(encoder.encode(HPKE_V1), suiteId, encoder.encode(label), ikm));
}

function labeledExpand(
	suiteId: Uint8Array,
	prk: Bytes,
	label: string,
	info: Uint8Array,
	length: number,
): Promise<Bytes> {
	return hkdfExpand(
		prk,
		concat(i2osp(length, 2), encoder.encode(HPKE_V1), suiteId, encoder.encode(label), info),
		length,
	);
}

async function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Promise<Bytes> {
	const eaePrk = await labeledExtract(kemSuiteId(), new Uint8Array(), "eae_prk", dh);
	return labeledExpand(kemSuiteId(), eaePrk, "shared_secret", kemContext, N_SECRET);
}

async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.length !== N_PK || raw[0] !== 0x04) throw new SealedFormatError("invalid_public_key");
	try {
		return await crypto.subtle.importKey("raw", own(raw), { name: "ECDH", namedCurve: "P-256" }, true, []);
	} catch {
		throw new SealedFormatError("invalid_public_key");
	}
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function importPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array): Promise<CryptoKey> {
	if (privateKey.length !== 32 || publicKey.length !== N_PK || publicKey[0] !== 0x04) {
		throw new SealedFormatError("invalid_private_key");
	}
	try {
		return await crypto.subtle.importKey(
			"jwk",
			{
				kty: "EC",
				crv: "P-256",
				d: base64Url(privateKey),
				x: base64Url(publicKey.subarray(1, 33)),
				y: base64Url(publicKey.subarray(33, 65)),
			},
			{ name: "ECDH", namedCurve: "P-256" },
			false,
			["deriveBits"],
		);
	} catch {
		throw new SealedFormatError("invalid_private_key");
	}
}

async function ecdh(privateKey: CryptoKey, peer: Uint8Array): Promise<Bytes> {
	const peerKey = await importPublicKey(peer);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, privateKey, N_DH * 8));
}

/** A recipient whose private scalar is held in this process (device keys, tests). */
export async function p256Recipient(privateKey: Uint8Array, publicKey: Uint8Array): Promise<HpkeRecipient> {
	const key = await importPrivateKey(privateKey, publicKey);
	return { publicKey: Uint8Array.from(publicKey), dh: (peer) => ecdh(key, peer) };
}

/** RFC 9180 Decap: the shared secret for `enc` addressed to `recipient`. */
export async function hpkeDecap(recipient: HpkeRecipient, enc: Uint8Array): Promise<Bytes> {
	await importPublicKey(enc);
	const dh = await recipient.dh(enc);
	return extractAndExpand(dh, concat(enc, recipient.publicKey));
}

/**
 * RFC 9180 Encap with a caller-supplied ephemeral key pair. KNOWN-ANSWER TESTS ONLY: reusing an ephemeral key
 * across wraps breaks HPKE's guarantees. Production sealing goes through {@link hpkeSealBase}, which mints one.
 * @internal
 */
export async function hpkeEncapDeterministic(
	recipientPublicKey: Uint8Array,
	ephemeralPrivateKey: Uint8Array,
	ephemeralPublicKey: Uint8Array,
): Promise<{ readonly enc: Uint8Array; readonly sharedSecret: Uint8Array }> {
	const ephemeral = await importPrivateKey(ephemeralPrivateKey, ephemeralPublicKey);
	return encapWith(recipientPublicKey, ephemeral, Uint8Array.from(ephemeralPublicKey));
}

async function encapWith(
	recipientPublicKey: Uint8Array,
	ephemeral: CryptoKey,
	enc: Uint8Array,
): Promise<{ readonly enc: Uint8Array; readonly sharedSecret: Uint8Array }> {
	const dh = await ecdh(ephemeral, recipientPublicKey);
	return { enc, sharedSecret: await extractAndExpand(dh, concat(enc, recipientPublicKey)) };
}

/** RFC 9180 KeySchedule for mode_base (no PSK). The exporter secret is not derived: the format never exports. */
export async function hpkeKeySchedule(
	sharedSecret: Uint8Array,
	info: Uint8Array,
): Promise<{ readonly key: Bytes; readonly baseNonce: Bytes }> {
	const empty = new Uint8Array();
	const pskIdHash = await labeledExtract(hpkeSuiteId(), empty, "psk_id_hash", empty);
	const infoHash = await labeledExtract(hpkeSuiteId(), empty, "info_hash", info);
	const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
	const secret = await labeledExtract(hpkeSuiteId(), sharedSecret, "secret", empty);
	return {
		key: await labeledExpand(hpkeSuiteId(), secret, "key", context, N_K),
		baseNonce: await labeledExpand(hpkeSuiteId(), secret, "base_nonce", context, N_N),
	};
}

async function aesGcmKey(key: Bytes, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", key, { name: "AES-GCM", length: N_K * 8 }, false, [usage]);
}

/** Single-shot HPKE seal (sequence 0) to `recipientPublicKey` under a freshly generated ephemeral key. */
export async function hpkeSealBase(recipientPublicKey: Uint8Array, input: HpkeSealInput): Promise<HpkeSealed> {
	await importPublicKey(recipientPublicKey);
	const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
	const enc = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
	const { sharedSecret } = await encapWith(recipientPublicKey, ephemeral.privateKey, enc);
	const { key, baseNonce } = await hpkeKeySchedule(sharedSecret, input.info);
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: baseNonce, additionalData: own(input.aad), tagLength: N_T * 8 },
		await aesGcmKey(key, "encrypt"),
		own(input.pt),
	);
	sharedSecret.fill(0);
	key.fill(0);
	return { enc, ct: new Uint8Array(ct) };
}

/** Single-shot HPKE open (sequence 0). Any failure is the one code `open_failed`. */
export async function hpkeOpenBase(recipient: HpkeRecipient, input: HpkeOpenInput): Promise<Bytes> {
	if (input.ct.length < N_T) throw new SealedFormatError("open_failed");
	let sharedSecret: Bytes | undefined;
	let key: Bytes | undefined;
	try {
		sharedSecret = await hpkeDecap(recipient, input.enc);
		const schedule = await hpkeKeySchedule(sharedSecret, input.info);
		key = schedule.key;
		const pt = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: schedule.baseNonce, additionalData: own(input.aad), tagLength: N_T * 8 },
			await aesGcmKey(key, "decrypt"),
			own(input.ct),
		);
		return new Uint8Array(pt);
	} catch {
		throw new SealedFormatError("open_failed");
	} finally {
		sharedSecret?.fill(0);
		key?.fill(0);
	}
}
