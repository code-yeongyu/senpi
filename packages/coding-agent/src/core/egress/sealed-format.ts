/**
 * Sealed custody formats (C6, row CK3): provider fields under the provider DEK, the account config object under K_cfg,
 * and HPKE key wraps (K_cfg, K_proj, DEK) to device and custody keys.
 *
 * Every AAD is rebuilt by the opener from its own context and never stored. Its bytes are a per-kind ASCII label, a NUL
 * and the canonical JSON of a flat record whose members are all required strings or one safe integer: on that domain
 * the encoding is injective, so a ciphertext cannot move between accounts, providers, owners, digests, positions, DEK
 * generations, wrap kinds, recipient keys or format versions. The label names the format version and, for the raw
 * AES-GCM paths, the exact algorithm: AES-256-GCM, 96-bit nonce, 128-bit tag.
 *
 * Nonces come from the CSPRNG only, never a counter: K_cfg is sealed by every enrolled device. NIST SP 800-38D allows
 * 2^32 random-nonce seals per key; a DEK sees about fields x refreshes and K_cfg one seal per publish per device, both
 * orders of magnitude below. AES-GCM is not key-committing; that is safe here because every key is 256-bit random and
 * only a dekId's owner can submit a wrap for it, who could plant any value anyway. AES-GCM-SIV is not in Web Crypto.
 */
import { canonicalJson } from "@earendil-works/pi-agent-core";
import { type HpkeRecipient, hpkeOpenBase, hpkeSealBase, SealedFormatError } from "./hpke.ts";

export { SealedFormatError, type SealedFormatErrorCode } from "./hpke.ts";

// Plain aliases until CK1 (senpi#5857) exports them from pi-agent-core.
export type ProviderId = string;
export type DeviceId = string;

export type SecretField =
	| "apiKey"
	| `credential:${number}`
	| `header:${string}`
	| `modelHeader:${string}:${string}`
	| "urlUserinfo"
	| `urlPath:${number}`
	| `urlQuery:${string}`;

declare const sourceDigestBrand: unique symbol;
declare const dekIdBrand: unique symbol;
export type SourceDigest = string & { readonly [sourceDigestBrand]: true };
export type DekId = string & { readonly [dekIdBrand]: true };

const isSourceDigest = (value: string): value is SourceDigest => /^[A-Za-z0-9:_-]{1,256}$/.test(value);
const isDekId = (value: string): value is DekId => /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** The one boundary parser for a source digest read from an entry; a FieldAad cannot be built without one. */
export function parseSourceDigest(value: string): SourceDigest {
	if (!isSourceDigest(value)) throw new SealedFormatError("invalid_aad");
	return value;
}

/** The one boundary parser for a dekId read from an entry; a FieldAad cannot be built without one. */
export function parseDekId(value: string): DekId {
	if (!isDekId(value)) throw new SealedFormatError("invalid_aad");
	return value;
}

export interface FieldAad {
	readonly account: string;
	readonly provider: ProviderId;
	readonly owner: DeviceId;
	readonly sourceDigest: SourceDigest;
	readonly field: SecretField;
	readonly dekId: DekId;
}
export type WrapKind = "cfg" | "dek" | "proj";
export interface WrapPosition {
	readonly account: string;
	readonly kind: WrapKind;
	readonly id: string;
}
export interface WrapAad extends WrapPosition {
	readonly recipientKeyId: string;
}
export interface ConfigAad {
	readonly accountId: string;
	readonly version: number;
	readonly cfgKeyId: string;
}

export const HPKE_SUITE = "DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM";
export interface HpkeWrap {
	readonly suite: typeof HPKE_SUITE;
	readonly enc: string;
	readonly ct: string;
}
export interface SealedBlob {
	readonly nonce: string;
	readonly ct: string;
}
export type FieldSource = "literal" | "env" | "command" | "oauth_access";
export interface SealedFieldMeta {
	readonly source: FieldSource;
	readonly resolvedAt: number;
	readonly expiresAt?: number;
	readonly refreshable: boolean;
}
export type SealedField =
	| ({ readonly v: 1; readonly state: "sealed"; readonly meta: SealedFieldMeta } & SealedBlob)
	| {
			readonly v: 1;
			readonly state: "unresolved";
			readonly meta: {
				readonly source: "env" | "command" | "oauth_access";
				readonly attemptedAt: number;
				readonly refreshable: true;
			};
	  };
export interface ConfigEnvelope extends ConfigAad {
	readonly v: 1;
	readonly cfg: SealedBlob;
}
/** A recipient that knows its own key id: the opener's id, never one read from a stored wrap, enters the AAD. */
export interface KeyedRecipient extends HpkeRecipient {
	readonly keyId: string;
}

type Bytes = Uint8Array<ArrayBuffer>;
type AadLabel = "omo-custody/field-aad/v1" | "omo-custody/wrap-aad/v1" | "omo-custody/cfg-aad/v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const encoder = new TextEncoder();

function text(value: unknown): string {
	if (typeof value !== "string") throw new SealedFormatError("invalid_aad");
	return value;
}

function counter(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new SealedFormatError("invalid_aad");
	return value;
}

function aadBytes(label: AadLabel, record: Readonly<Record<string, string | number>>): Bytes {
	return encoder.encode(`${label}\u0000${canonicalJson(record)}`);
}

/** @internal Exposed for the encoding vectors. */
export function fieldAadBytes(aad: FieldAad): Bytes {
	return aadBytes("omo-custody/field-aad/v1", {
		account: text(aad.account),
		provider: text(aad.provider),
		owner: text(aad.owner),
		sourceDigest: text(aad.sourceDigest),
		field: text(aad.field),
		dekId: text(aad.dekId),
	});
}

/** @internal Exposed for the encoding vectors. */
export function wrapAadBytes(aad: WrapAad): Bytes {
	return aadBytes("omo-custody/wrap-aad/v1", {
		account: text(aad.account),
		kind: text(aad.kind),
		id: text(aad.id),
		recipientKeyId: text(aad.recipientKeyId),
	});
}

/** @internal Exposed for the encoding vectors. */
export function configAadBytes(aad: ConfigAad): Bytes {
	return aadBytes("omo-custody/cfg-aad/v1", {
		accountId: text(aad.accountId),
		version: counter(aad.version),
		cfgKeyId: text(aad.cfgKeyId),
	});
}

const wrapInfo = (kind: WrapKind): Bytes => encoder.encode(`omo-custody/wrap/v1/${kind}`);

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Strict: no padding, no foreign characters, no non-zero trailing bits, so one byte string has one encoding. */
export function decodeBase64Url(value: string): Bytes {
	if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new SealedFormatError("open_failed");
	const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	if (encodeBase64Url(bytes) !== value) throw new SealedFormatError("open_failed");
	return bytes;
}

async function aesKey(key: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
	if (key.length !== KEY_BYTES) throw new SealedFormatError("invalid_key");
	return crypto.subtle.importKey("raw", Uint8Array.from(key), { name: "AES-GCM" }, false, [usage]);
}

async function aes256GcmSeal(key: Uint8Array, aad: Bytes, plaintext: Bytes): Promise<SealedBlob> {
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
		await aesKey(key, "encrypt"),
		plaintext,
	);
	return { nonce: encodeBase64Url(nonce), ct: encodeBase64Url(new Uint8Array(ct)) };
}

/** @internal Raw AES-256-GCM open, exposed for the external known-answer vector. Any failure is `open_failed`. */
export async function aes256GcmOpen(
	key: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	ct: Uint8Array,
): Promise<Bytes> {
	const cryptoKey = await aesKey(key, "decrypt");
	if (nonce.length !== NONCE_BYTES || ct.length < TAG_BYTES) throw new SealedFormatError("open_failed");
	try {
		const pt = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: Uint8Array.from(nonce),
				additionalData: Uint8Array.from(aad),
				tagLength: TAG_BYTES * 8,
			},
			cryptoKey,
			Uint8Array.from(ct),
		);
		return new Uint8Array(pt);
	} catch {
		throw new SealedFormatError("open_failed");
	}
}

const openBlob = (key: Uint8Array, aad: Bytes, blob: SealedBlob): Promise<Bytes> =>
	aes256GcmOpen(key, decodeBase64Url(blob.nonce), aad, decodeBase64Url(blob.ct));

function requireVersion1(v: unknown): void {
	if (v !== 1) throw new SealedFormatError("unsupported_version");
}

/** Seals one secret under the provider DEK. Empty secrets are never sealed. */
export async function sealField(
	dek: Uint8Array,
	aad: FieldAad,
	secret: string,
	meta: SealedFieldMeta,
): Promise<Extract<SealedField, { state: "sealed" }>> {
	if (secret.length === 0) throw new SealedFormatError("empty_secret");
	const blob = await aes256GcmSeal(dek, fieldAadBytes(aad), encoder.encode(secret));
	return { v: 1, state: "sealed", ...blob, meta };
}

/** Opens a sealed field under the AAD the opener rebuilt from the entry and the requested position. */
export async function openField(dek: Uint8Array, aad: FieldAad, field: SealedField): Promise<Bytes> {
	requireVersion1(field.v);
	if (field.state !== "sealed") throw new SealedFormatError("open_failed");
	return openBlob(dek, fieldAadBytes(aad), field);
}

export function sealConfig(kCfg: Uint8Array, aad: ConfigAad, plaintext: Uint8Array): Promise<SealedBlob> {
	return aes256GcmSeal(kCfg, configAadBytes(aad), Uint8Array.from(plaintext));
}

/** Opens the config object; its AAD is rebuilt from the envelope's own public fields. */
export async function openConfig(kCfg: Uint8Array, envelope: ConfigEnvelope): Promise<Bytes> {
	requireVersion1(envelope.v);
	return openBlob(kCfg, configAadBytes(envelope), envelope.cfg);
}

export async function wrapKey(recipientPublicKey: Uint8Array, aad: WrapAad, key: Uint8Array): Promise<HpkeWrap> {
	if (key.length === 0) throw new SealedFormatError("invalid_key");
	const sealed = await hpkeSealBase(recipientPublicKey, { info: wrapInfo(aad.kind), aad: wrapAadBytes(aad), pt: key });
	return { suite: HPKE_SUITE, enc: encodeBase64Url(sealed.enc), ct: encodeBase64Url(sealed.ct) };
}

/** Opens a wrap at `position` with the recipient's own key id; nothing read from the wrap enters the AAD. */
export async function unwrapKey(recipient: KeyedRecipient, position: WrapPosition, wrap: HpkeWrap): Promise<Bytes> {
	if (wrap.suite !== HPKE_SUITE) throw new SealedFormatError("unsupported_version");
	const aad: WrapAad = {
		account: position.account,
		kind: position.kind,
		id: position.id,
		recipientKeyId: recipient.keyId,
	};
	return hpkeOpenBase(recipient, {
		enc: decodeBase64Url(wrap.enc),
		ct: decodeBase64Url(wrap.ct),
		info: wrapInfo(aad.kind),
		aad: wrapAadBytes(aad),
	});
}
