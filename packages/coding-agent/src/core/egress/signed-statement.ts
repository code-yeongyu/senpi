/**
 * Verifier-signed statements: the trust anchor of the key-facts channel (custody design 15.10).
 *
 * The verifier serves `{ "payload": <base64url of the exact signed bytes>, "sig": <base64url P1363> }`, signed
 * under `"omo-key-facts/v1\n" || bytes` by a verifier key this release pins. The client verifies the bytes it
 * received BEFORE parsing them, then parses strictly: the bytes must be exactly their canonical JSON (sorted keys,
 * no whitespace), so duplicate keys and trailing bytes are refused. TLS and the host CA store carry the bytes and
 * are trusted for nothing.
 */
import { canonicalJson, toStoreValue } from "@earendil-works/pi-agent-core";
import { verifyP1363Sha256 } from "./ecdsa-p256.ts";

const STATEMENT_DOMAIN = "omo-key-facts/v1\n";

export interface VerifierKeyPin {
	readonly keyId: string;
	readonly generation: number;
	/** Base64 SPKI of the verifier's P-256 signing key. */
	readonly spki: string;
}

export type StatementFields = Readonly<Record<string, unknown>>;

export interface VerifiedStatement {
	readonly signer: VerifierKeyPin;
	readonly fields: StatementFields;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function isRecord(value: unknown): value is StatementFields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict unpadded base64url: one accepted encoding per byte string. */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
	if (!BASE64URL.test(value)) return undefined;
	const bytes = new Uint8Array(Buffer.from(value, "base64url"));
	return Buffer.from(bytes).toString("base64url") === value ? bytes : undefined;
}

function parseEnvelope(body: string): { readonly payload: string; readonly sig: string } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;
	const { payload, sig } = value;
	return typeof payload === "string" && typeof sig === "string" ? { payload, sig } : undefined;
}

function parseCanonical(bytes: Uint8Array): StatementFields | undefined {
	let text: string;
	let value: unknown;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	return isRecord(value) && canonicalJson(toStoreValue(value)) === text ? value : undefined;
}

/**
 * The statement in `body` if a pinned key that `canSign` admits signed exactly its payload bytes and the
 * statement names that key as its `verifierKeyId`; `undefined` on any failure.
 */
export async function verifySignedStatement(
	body: string,
	pins: readonly VerifierKeyPin[],
	canSign: (pin: VerifierKeyPin) => boolean,
): Promise<VerifiedStatement | undefined> {
	const envelope = parseEnvelope(body);
	const bytes = envelope && decodeBase64Url(envelope.payload);
	const signature = envelope && decodeBase64Url(envelope.sig);
	if (!bytes || !signature) return undefined;
	const message = new Uint8Array([...new TextEncoder().encode(STATEMENT_DOMAIN), ...bytes]);
	let signer: VerifierKeyPin | undefined;
	for (const pin of pins) {
		if (canSign(pin) && (await verifyP1363Sha256(pin.spki, message, signature))) {
			signer = pin;
			break;
		}
	}
	if (!signer) return undefined;
	const fields = parseCanonical(bytes);
	return fields && fields.verifierKeyId === signer.keyId && fields.v === 1 ? { signer, fields } : undefined;
}

export function hasExactKeys(
	record: StatementFields,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(record);
	return (
		required.every((key) => keys.includes(key)) &&
		keys.every((key) => required.includes(key) || optional.includes(key))
	);
}
