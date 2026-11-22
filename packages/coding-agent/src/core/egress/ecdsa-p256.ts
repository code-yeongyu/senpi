/**
 * ECDSA P-256 / SHA-256 verification for signatures produced by KMS `Sign` (custody design 3.1).
 *
 * KMS returns DER; WebCrypto verifies IEEE P1363. The DER parser is strict so one signature has exactly one
 * accepted encoding, and every failure is `false`, never a thrown error.
 */
const P256_ORDER_BYTES = 32;

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;
	return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Strict DER `SEQUENCE { INTEGER r, INTEGER s }` -> IEEE P1363 `r || s` (64 bytes), the form WebCrypto
 * verifies. Non-minimal lengths, negative or zero-padded-without-need integers, values wider than the
 * curve order and trailing bytes are all refused, so one signature has exactly one accepted encoding.
 */
export function derEcdsaSignatureToP1363(der: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
	if (der.length < 8 || der[0] !== 0x30) return undefined;
	const seqLength = der[1];
	if (seqLength === undefined || seqLength >= 0x80 || seqLength !== der.length - 2) return undefined;
	const out = new Uint8Array(P256_ORDER_BYTES * 2);
	let offset = 2;
	for (const slot of [0, 1]) {
		if (der[offset] !== 0x02) return undefined;
		const length = der[offset + 1];
		if (length === undefined || length === 0 || length >= 0x80) return undefined;
		const start = offset + 2;
		const end = start + length;
		if (end > der.length) return undefined;
		const first = der[start] ?? 0;
		const second = der[start + 1] ?? 0;
		if (first & 0x80) return undefined; // negative
		if (first === 0x00 && (length === 1 || !(second & 0x80))) return undefined; // non-minimal
		const magnitude = first === 0x00 ? der.subarray(start + 1, end) : der.subarray(start, end);
		if (magnitude.length > P256_ORDER_BYTES) return undefined;
		out.set(magnitude, slot * P256_ORDER_BYTES + (P256_ORDER_BYTES - magnitude.length));
		offset = end;
	}
	return offset === der.length ? out : undefined;
}

/** ECDSA P-256 / SHA-256 verification of a KMS-style DER signature under a base64 SPKI public key. */
export async function verifyEcdsaP256Sha256(
	spkiBase64: string,
	message: Uint8Array<ArrayBuffer>,
	derSigBase64: string,
): Promise<boolean> {
	const der = decodeBase64(derSigBase64);
	const signature = der && derEcdsaSignatureToP1363(der);
	return signature ? verifyP1363Sha256(spkiBase64, message, signature) : false;
}

/** ECDSA P-256 / SHA-256 verification of an IEEE P1363 `r || s` signature under a base64 SPKI public key. */
export async function verifyP1363Sha256(
	spkiBase64: string,
	message: Uint8Array<ArrayBuffer>,
	signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	const spki = decodeBase64(spkiBase64);
	if (!spki || signature.length !== P256_ORDER_BYTES * 2) return false;
	try {
		const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, [
			"verify",
		]);
		return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, message);
	} catch {
		// A malformed or wrong-curve SPKI is an unverifiable signature, not an error to surface.
		return false;
	}
}
