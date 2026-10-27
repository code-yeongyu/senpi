declare const identity: unique symbol;

/** An opaque protocol identifier: ASCII from the allow-list below, 1..128 bytes (S09-Q2 A, RULING-57 Q2). */
export type BoundedId = string & { readonly [identity]: "BoundedId" };
/** A SHA-256 digest: exactly 64 lowercase hex characters. */
export type ContentDigest = string & { readonly [identity]: "ContentDigest" };
/** A catalog ref: a 16-digit catalog counter root and three-digit child steps, meaningful only under its token. */
export type ContentRef = string & { readonly [identity]: "ContentRef" };

type IdentityRefusal = "empty" | "overlong" | "forbidden_character" | "malformed";
type IdentityOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: IdentityRefusal };

export const BOUNDED_ID_MAX_BYTES = 128;
const COUNTER_DIGITS = 16;
/** Child descriptors per catalog node (R4.B1), the bound of every child step. */
export const CATALOG_NODE_MAX_ENTRIES = 128;
const STEP_DIGITS = 3;
/** No path separator, dot, quote, backslash, space, control or non-ASCII character, so '..' cannot be formed. */
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const CONTENT_DIGEST = /^[0-9a-f]{64}$/;
const CONTENT_REF = /^c-[0-9]{16}(?::[0-9]{3})*$/;

const refused = (reason: IdentityRefusal): IdentityOutcome<never> => ({ ok: false, reason });

/** The allow-list check every identifier passes before any use as a key, a path element or a log field. */
export function parseBoundedId(value: string): IdentityOutcome<BoundedId> {
	if (value.length === 0) return refused("empty");
	if (Buffer.byteLength(value) > BOUNDED_ID_MAX_BYTES) return refused("overlong");
	if (!BOUNDED_ID.test(value)) return refused("forbidden_character");
	return { ok: true, value: value as BoundedId };
}

export function parseContentDigest(value: string): IdentityOutcome<ContentDigest> {
	if (value.length === 0) return refused("empty");
	if (!CONTENT_DIGEST.test(value)) return refused("malformed");
	return { ok: true, value: value as ContentDigest };
}

export function parseContentRef(value: string): IdentityOutcome<ContentRef> {
	const bounded = parseBoundedId(value);
	if (!bounded.ok) return bounded;
	if (!CONTENT_REF.test(value)) return refused("malformed");
	return { ok: true, value: value as ContentRef };
}

/** A literal or generated protocol identifier; a refusal is a programming error, never input. */
export function protocolId(value: string): BoundedId {
	const parsed = parseBoundedId(value);
	if (!parsed.ok) throw new RangeError(`not a bounded protocol id (${parsed.reason}): ${value.length} chars`);
	return parsed.value;
}

function fixed(value: number, digits: number, bound: number, what: string): string {
	if (!Number.isSafeInteger(value) || value < 0 || value >= bound)
		throw new RangeError(`${what} out of range: ${value}`);
	return String(value).padStart(digits, "0");
}

function minted(value: string): ContentRef {
	const parsed = parseContentRef(value);
	if (!parsed.ok) throw new RangeError(`catalog ref ${parsed.reason}`);
	return parsed.value;
}

export const catalogRootRef = (counter: number): ContentRef =>
	minted(`c-${fixed(counter, COUNTER_DIGITS, 10 ** COUNTER_DIGITS, "catalog counter")}`);

export const childRef = (parent: ContentRef, index: number): ContentRef =>
	minted(`${parent}:${fixed(index, STEP_DIGITS, CATALOG_NODE_MAX_ENTRIES, "catalog child index")}`);

/** The child indexes from the catalog root to the ref. */
export const refSteps = (ref: ContentRef): readonly number[] => ref.split(":").slice(1).map(Number);
