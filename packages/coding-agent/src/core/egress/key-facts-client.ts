/**
 * The anchored key-facts reader (custody design 3.1 "Read path", 15.10).
 *
 * Facts and revocations come from the key-facts verifier as verifier-signed statements
 * (`signed-statement.ts`) under a key this release pins. The endpoint is transport only: a TLS interposer can
 * withhold or replay bytes, never forge them, and a replay fails the nonce echo. Every failure is `"unknown"`.
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	hasExactKeys,
	isRecord,
	type StatementFields,
	type VerifierKeyPin,
	verifySignedStatement,
} from "./signed-statement.ts";
import {
	acceptedRevocations,
	isKeyRevoked,
	isVouchRevoked,
	parseRevocationsStatement,
	type RevocationFreshness,
	readVerifierRevocations,
	recordVerifierRevocations,
} from "./verifier-revocations.ts";

export interface KmsKeyFacts {
	readonly spki: string;
	readonly origin: "AWS_KMS" | "EXTERNAL" | "AWS_CLOUDHSM" | "EXTERNAL_KEY_STORE";
	readonly keySpec: string;
	readonly keyUsage: "KEY_AGREEMENT" | "SIGN_VERIFY" | "ENCRYPT_DECRYPT";
	readonly keyManager: "CUSTOMER" | "AWS";
	readonly keyState: string;
	readonly multiRegion: boolean;
	readonly tags: Readonly<Record<string, string>>;
	/** JSON of GetKeyPolicy; the check re-canonicalizes it before comparing. */
	readonly policy: string;
	readonly grantCount: number;
	/** When the verifier read these facts upstream (ms since epoch); the record's `vouchedAt`. */
	readonly readAt: number;
	/** The pinned verifier key that signed these facts; the record's `verifierKeyId`. */
	readonly verifierKeyId: string;
}

/**
 * A verified statement whose `readAt` is outside the age bounds on this device's clock. Kept apart from `"unknown"`
 * so the check can tell the user to look at the clock; `skewMs` is `now - readAt` (negative: facts from the future).
 */
export interface KeyFactsStale {
	readonly refusal: "facts-stale";
	readonly skewMs: number;
}

export type KeyFactsAnswer = KmsKeyFacts | KeyFactsStale | "unknown";

export interface KmsKeyReader {
	describe(keyArn: string): Promise<KeyFactsAnswer>;
}

export interface AnchoredKeyFactsReader extends KmsKeyReader {
	refreshRevocations(): Promise<boolean>;
	revocationFreshness(): RevocationFreshness | undefined;
}

export interface AnchoredKeyFactsReaderOptions {
	readonly endpoint: string | undefined;
	readonly verifierKeys: readonly VerifierKeyPin[];
	readonly revocationsPath: string;
	readonly now?: () => number;
	readonly monoNow?: () => number;
	readonly fetch?: typeof fetch;
}

export const MAX_FACTS_AGE_MS = 120_000;
export const MAX_FACTS_FUTURE_SKEW_MS = 30_000;
const MAX_STATEMENT_BYTES = 64 * 1024;
const STATEMENT_TIMEOUT_MS = 10_000;

const ORIGINS = ["AWS_KMS", "EXTERNAL", "AWS_CLOUDHSM", "EXTERNAL_KEY_STORE"] as const;
const KEY_USAGES = ["KEY_AGREEMENT", "SIGN_VERIFY", "ENCRYPT_DECRYPT"] as const;
const KEY_MANAGERS = ["CUSTOMER", "AWS"] as const;
const FACT_KEYS = [
	"spki",
	"origin",
	"keySpec",
	"keyUsage",
	"keyManager",
	"keyState",
	"multiRegion",
	"tags",
	"policy",
	"grantCount",
];
const STATEMENT_KEYS = ["v", "kind", "arn", "nonce", "readAt", "facts", "verifierKeyId"];

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
	values.some((candidate) => candidate === value);

function parseTags(value: unknown): Readonly<Record<string, string>> | undefined {
	if (!isRecord(value)) return undefined;
	const tags: Record<string, string> = {};
	for (const [key, tag] of Object.entries(value)) {
		if (typeof tag !== "string") return undefined;
		tags[key] = tag;
	}
	return tags;
}

function parseFacts(fields: StatementFields, readAt: number, verifierKeyId: string): KmsKeyFacts | undefined {
	const { facts } = fields;
	if (!isRecord(facts) || !hasExactKeys(facts, FACT_KEYS)) return undefined;
	const { spki, origin, keySpec, keyUsage, keyManager, keyState, multiRegion, tags, policy, grantCount } = facts;
	const parsedTags = parseTags(tags);
	if (typeof spki !== "string" || typeof keySpec !== "string" || typeof keyState !== "string") return undefined;
	if (!oneOf(ORIGINS, origin) || !oneOf(KEY_USAGES, keyUsage) || !oneOf(KEY_MANAGERS, keyManager)) return undefined;
	if (typeof multiRegion !== "boolean" || typeof policy !== "string" || !isCount(grantCount) || !parsedTags)
		return undefined;
	return {
		spki,
		origin,
		keySpec,
		keyUsage,
		keyManager,
		keyState,
		multiRegion,
		tags: parsedTags,
		policy,
		grantCount,
		readAt,
		verifierKeyId,
	};
}

async function boundedBody(response: Response): Promise<string | undefined> {
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_STATEMENT_BYTES) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function anchoredKeyFactsReader(options: AnchoredKeyFactsReaderOptions): AnchoredKeyFactsReader {
	const now = options.now ?? Date.now;
	const monoNow = options.monoNow ?? (() => performance.now());
	const request = options.fetch ?? fetch;
	const pins = options.verifierKeys;
	let freshness: RevocationFreshness | undefined;

	async function get(path: string, nonce: string): Promise<string | undefined> {
		if (options.endpoint === undefined || pins.length === 0) return undefined;
		const sent = monoNow();
		try {
			const response = await request(`${options.endpoint}${path}?nonce=${nonce}`, {
				redirect: "manual",
				signal: AbortSignal.timeout(STATEMENT_TIMEOUT_MS),
			});
			const type = response.headers.get("content-type") ?? "";
			if (response.status !== 200 || !/^application\/json(;|$)/.test(type)) return undefined;
			const body = await boundedBody(response);
			return monoNow() - sent < STATEMENT_TIMEOUT_MS ? body : undefined;
		} catch {
			return undefined;
		}
	}

	async function refreshRevocations(): Promise<boolean> {
		const nonce = randomBytes(16).toString("base64url");
		const fetchedMono = monoNow();
		const body = await get("/v1/revocations", nonce);
		const held = await readVerifierRevocations(options.revocationsPath);
		if (body === undefined || held.state !== "ok") return false;
		const verified = await verifySignedStatement(body, pins, (pin) => !isKeyRevoked(held.revocations, pin.keyId));
		const statement = verified && parseRevocationsStatement(verified.fields, nonce);
		if (!verified || !statement) return false;
		const accepted = acceptedRevocations(statement.revocations, verified.signer, pins, held.revocations);
		if (!(await recordVerifierRevocations(options.revocationsPath, accepted))) return false;
		freshness = { issuedAt: statement.issuedAt, fetchedMono };
		return true;
	}

	async function describe(keyArn: string): Promise<KeyFactsAnswer> {
		const nonce = randomBytes(16).toString("base64url");
		const body = await get(`/v1/keys/${encodeURIComponent(keyArn)}`, nonce);
		const held = await readVerifierRevocations(options.revocationsPath);
		if (body === undefined || held.state !== "ok") return "unknown";
		const verified = await verifySignedStatement(body, pins, (pin) => !isKeyRevoked(held.revocations, pin.keyId));
		if (!verified || !hasExactKeys(verified.fields, STATEMENT_KEYS)) return "unknown";
		const { kind, arn, readAt } = verified.fields;
		if (kind !== "facts" || arn !== keyArn || verified.fields.nonce !== nonce || !isCount(readAt)) return "unknown";
		const at = now();
		if (at - readAt > MAX_FACTS_AGE_MS || readAt - at > MAX_FACTS_FUTURE_SKEW_MS)
			return { refusal: "facts-stale", skewMs: at - readAt };
		const facts = parseFacts(verified.fields, readAt, verified.signer.keyId);
		if (!facts || facts.keyState !== "Enabled" || !(await refreshRevocations())) return "unknown";
		const after = await readVerifierRevocations(options.revocationsPath);
		if (after.state !== "ok" || isVouchRevoked(after.revocations, facts.verifierKeyId, readAt)) return "unknown";
		return facts;
	}

	return { describe, refreshRevocations, revocationFreshness: () => freshness };
}
