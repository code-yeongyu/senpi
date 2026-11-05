import type { KeyObject } from "node:crypto";
import { isRecord } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import { strictEd25519Verify } from "./ed25519-strict.ts";
import type { AccountPrincipal, PresenterAccountAuthority } from "./mcp-presenter-account.ts";
import type { SecretHostToken } from "./secret-host-token.ts";
import { openSecretAnswer } from "./secret-sealed-hpke.ts";
import {
	secretAnswerAad,
	secretAnswerInfo,
	secretAnswerTranscript,
	secretCancelTranscript,
	unpadSecretValue,
} from "./secret-sealed.ts";

/** Design 7.1 steps 1, 4 and 5 for `mcp_presenter_secret_answer`, in the process that holds the authority. */

/** 0020's delegated-lane line id bound; `answerId` keeps the raiser route's 1..256. */
const LINE_ID_MAX = 128;
const CT_MIN = 256 + 16;
const CT_MAX = 65536 + 16;
const VALUE_KEYS = ["type", "id", "v", "grantId", "uiRequestId", "answerId", "stepup", "enc", "ct", "sig"];
const CANCEL_KEYS = ["type", "id", "v", "grantId", "uiRequestId", "answerId", "cancelled", "sig"];

export interface SealedAnswerFrame {
	readonly id: string;
	readonly grantId: string;
	readonly uiRequestId: string;
	readonly answerId: string;
	readonly sig: Buffer;
	readonly value?: { readonly stepup: string; readonly enc: Buffer; readonly ct: Buffer };
}

function bounded(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function base64url(value: unknown, min: number, max: number): Buffer | undefined {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
	const bytes = Buffer.from(value, "base64url");
	return bytes.length >= min && bytes.length <= max && bytes.toString("base64url") === value ? bytes : undefined;
}

/** Step 1: the exact key set, `v === 1` and every bound; `undefined` is `invalid_secret_response`. */
export function parseSealedAnswer(value: unknown): SealedAnswerFrame | undefined {
	if (!isRecord(value) || value.type !== "mcp_presenter_secret_answer" || value.v !== 1) return undefined;
	const keys = Object.keys(value).sort();
	const cancel = value.cancelled === true;
	if (keys.join() !== [...(cancel ? CANCEL_KEYS : VALUE_KEYS)].sort().join()) return undefined;
	const { id, grantId, uiRequestId, answerId, sig } = value;
	if (!bounded(id, LINE_ID_MAX) || !bounded(grantId, 256) || !bounded(uiRequestId, 256) || !bounded(answerId, 256))
		return undefined;
	if (typeof sig !== "string" || !/^[0-9a-f]{128}$/.test(sig)) return undefined;
	const frame = { id, grantId, uiRequestId, answerId, sig: Buffer.from(sig, "hex") };
	if (cancel) return frame;
	const enc = base64url(value.enc, 32, 32);
	const ct = base64url(value.ct, CT_MIN, CT_MAX);
	if (!enc || !ct || !bounded(value.stepup, 8192)) return undefined;
	return { ...frame, value: { stepup: value.stepup, enc, ct } };
}

function jtiOf(token: string): string | undefined {
	try {
		const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		return isRecord(claims) && bounded(claims.jti, 256) ? claims.jti : undefined;
	} catch {
		return undefined;
	}
}

export interface SealedAnswerContext {
	readonly frame: SealedAnswerFrame;
	readonly principal: AccountPrincipal;
	readonly req: string;
	readonly deadlineAtMs: number;
	readonly hostToken: SecretHostToken | undefined;
	readonly account: PresenterAccountAuthority;
}

export type CheckedSealedAnswer =
	| { readonly ok: true; readonly jti?: string; readonly exp?: number }
	| { readonly ok: false; readonly error: "invalid_secret_response" | "secret_stepup_refused" };

function rawKey(key: KeyObject): Buffer {
	const { x } = key.export({ format: "jwk" });
	return Buffer.from(typeof x === "string" ? x : "", "base64url");
}

/**
 * Step 4: the envelope signature under the principal's installation key, verified strictly (decision 0022 SP-0 L4).
 * Step 5 for a value: `verifySecretAnswer` and the 6.5 host checks. The signed transcript names the token's `jti`,
 * which must equal the verified one.
 */
export async function checkSealedAnswer(context: SealedAnswerContext): Promise<CheckedSealedAnswer> {
	const { frame, principal, req } = context;
	const ids = { req, principalId: principal.id, grantId: frame.grantId, answerId: frame.answerId };
	const jti = frame.value ? jtiOf(frame.value.stepup) : undefined;
	if (frame.value && jti === undefined) return { ok: false, error: "invalid_secret_response" };
	const transcript =
		frame.value && jti !== undefined
			? secretAnswerTranscript(ids, jti, frame.value.enc, frame.value.ct)
			: secretCancelTranscript(ids);
	if (!strictEd25519Verify(rawKey(principal.key), Buffer.from(transcript), frame.sig))
		return { ok: false, error: "invalid_secret_response" };
	if (!frame.value) return { ok: true };
	const verify = context.account.verifySecretAnswer;
	if (!verify) return { ok: false, error: "secret_stepup_refused" };
	let result: Awaited<ReturnType<typeof verify>>;
	try {
		const spki = principal.key.export({ type: "spki", format: "der" });
		result = await verify.call(context.account, frame.value.stepup, spki, req, Math.floor(Date.now() / 1000));
	} catch {
		return { ok: false, error: "secret_stepup_refused" };
	}
	if (!result.ok) return { ok: false, error: "secret_stepup_refused" };
	const { stepUp } = result;
	const host = context.account.hostAccount();
	if (
		stepUp.jti !== jti ||
		host === undefined ||
		stepUp.acc !== host ||
		stepUp.acc !== principal.acc ||
		stepUp.dev !== principal.dev ||
		context.hostToken === undefined ||
		stepUp.hdev !== context.hostToken.dev ||
		!Number.isSafeInteger(stepUp.exp) ||
		stepUp.exp * 1000 > context.deadlineAtMs
	)
		return { ok: false, error: "secret_stepup_refused" };
	return { ok: true, jti, exp: stepUp.exp };
}

/** Step 6's open, run at the latch with the request key: HPKE open, then the canonical unpad. */
export function openSealedValue(
	frame: SealedAnswerFrame,
	ids: { readonly req: string; readonly principalId: string; readonly jti: string },
	key: KeyObject,
	hpkePk: string,
): string | undefined {
	if (!frame.value) return undefined;
	const plaintext = openSecretAnswer({
		privateKey: key,
		recipientPublicKey: Buffer.from(hpkePk, "base64url"),
		enc: frame.value.enc,
		ct: frame.value.ct,
		info: secretAnswerInfo(ids.req),
		aad: secretAnswerAad(ids.req, ids.principalId, frame.grantId, frame.answerId, ids.jti),
	});
	if (!plaintext) return undefined;
	const value = unpadSecretValue(plaintext);
	Buffer.from(plaintext).fill(0);
	return value;
}
