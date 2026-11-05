import { createPublicKey, verify } from "node:crypto";

/**
 * Strict Ed25519 verification for sealed secret transcripts (D11 secret phase; omo-relay-spec decisions 0003 and 0022).
 * Node's verifier accepts small-order and non-prime-order public keys, so a key a forger chose can make any message
 * verify. Before the native equation runs, this refuses: a public key or R that is not the canonical encoding of a
 * curve point, either one with order dividing 8, a public key outside the prime-order subgroup, and S >= L.
 * The arithmetic is variable-time and touches public values only.
 */

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(value: bigint): bigint {
	const r = value % P;
	return r < 0n ? r + P : r;
}

function pow(base: bigint, exponent: bigint): bigint {
	let result = 1n;
	let b = mod(base);
	for (let e = exponent; e > 0n; e >>= 1n) {
		if (e & 1n) result = mod(result * b);
		b = mod(b * b);
	}
	return result;
}

const D = mod(-121665n * pow(121666n, P - 2n));
const I = pow(2n, (P - 1n) / 4n);

interface Point {
	readonly x: bigint;
	readonly y: bigint;
	readonly z: bigint;
	readonly t: bigint;
}

const IDENTITY: Point = { x: 0n, y: 1n, z: 1n, t: 0n };

/** Extended twisted Edwards addition (a = -1), complete for every input pair. */
function add(p: Point, q: Point): Point {
	const a = mod((p.y - p.x) * (q.y - q.x));
	const b = mod((p.y + p.x) * (q.y + q.x));
	const c = mod(2n * D * p.t * q.t);
	const d = mod(2n * p.z * q.z);
	const e = b - a;
	const f = d - c;
	const g = d + c;
	const h = b + a;
	return { x: mod(e * f), y: mod(g * h), z: mod(f * g), t: mod(e * h) };
}

function times(point: Point, scalar: bigint): Point {
	let result = IDENTITY;
	let addend = point;
	for (let s = scalar; s > 0n; s >>= 1n) {
		if (s & 1n) result = add(result, addend);
		addend = add(addend, addend);
	}
	return result;
}

function isIdentity(p: Point): boolean {
	return mod(p.x) === 0n && mod(p.y - p.z) === 0n;
}

function littleEndian(bytes: Uint8Array): bigint {
	let value = 0n;
	for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] ?? 0);
	return value;
}

/** RFC 8032 5.1.3 decoding, refusing every non-canonical form: y >= p, no square root, or a negative zero x. */
function decodePoint(bytes: Uint8Array): Point | undefined {
	if (bytes.length !== 32) return undefined;
	const sign = ((bytes[31] ?? 0) >> 7) & 1;
	const y = littleEndian(bytes) & ((1n << 255n) - 1n);
	if (y >= P) return undefined;
	const u = mod(y * y - 1n);
	const v = mod(D * y * y + 1n);
	let x = mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n));
	const vx2 = mod(v * x * x);
	if (vx2 === mod(-u)) x = mod(x * I);
	else if (vx2 !== u) return undefined;
	if (x === 0n && sign === 1) return undefined;
	if (Number(x & 1n) !== sign) x = mod(-x);
	return { x, y, z: 1n, t: mod(x * y) };
}

function smallOrder(p: Point): boolean {
	return isIdentity(times(p, 8n));
}

/**
 * Verifies `signature` (64 bytes) over `message` under the raw 32-byte public key with the strict rules above.
 * Returns false for every refusal; the caller maps it to its own error code.
 */
export function strictEd25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
	if (publicKey.length !== 32 || signature.length !== 64) return false;
	const a = decodePoint(publicKey);
	const r = decodePoint(signature.subarray(0, 32));
	if (!a || !r || smallOrder(a) || smallOrder(r) || !isIdentity(times(a, L))) return false;
	if (littleEndian(signature.subarray(32)) >= L) return false;
	const key = createPublicKey({
		key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
		format: "jwk",
	});
	return verify(null, message, key, signature);
}
