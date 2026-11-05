import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";

/**
 * The engine half of sealed secret answers: omo-relay-spec decision 0022 section 3, at 5da46fd262 (D11 secret phase, design 4.1-4.3;
 * senpi#4249). Implemented here from the decision text; cross-implementation vectors are verified in the spec repo.
 */

/** `B` of 0022 3.2: `["omo-secret-binding-v1", hin, hostJkt, durableSessionId, uiRequestId, deadlineAtMs, hpkePk, displayHash]`. */
export type SecretBinding = readonly ["omo-secret-binding-v1", string, string, string, string, number, string, string];

export interface SecretBindingInput {
	readonly hostInstance: string;
	readonly hostJkt: string;
	readonly durableSessionId: string;
	readonly uiRequestId: string;
	readonly deadlineAtMs: number;
	readonly hpkePk: string;
	readonly title: string;
	readonly placeholder: string | undefined;
}

/** Engine to holder (design 4.3): sent only to a sealed holder, whose grant negotiated `secret_input_v1`. */
export interface McpPresenterSecretRequest {
	readonly type: "mcp_presenter_secret_request";
	readonly v: 1;
	readonly sessionId: string;
	readonly durableSessionId: string;
	readonly uiRequestId: string;
	readonly title: string;
	readonly placeholder?: string;
	readonly deadlineAtMs: number;
	readonly hostInstance: string;
	readonly hpkePk: string;
	readonly hostPk: string;
	readonly hostToken: string;
	readonly sig: string;
}

/** Engine to holder (design 3.2): a re-minted host token for every pending request of the session. Value-free. */
export interface McpPresenterSecretToken {
	readonly type: "mcp_presenter_secret_token";
	readonly v: 1;
	readonly hostInstance: string;
	readonly durableSessionId: string;
	readonly hostToken: string;
}

export type McpPresenterSecretFrame = McpPresenterSecretRequest | McpPresenterSecretToken;

/** The per-request X25519 key of 0022 3.1: the public half as unpadded base64url of the raw 32 bytes. */
export interface SecretRequestKey {
	readonly hpkePk: string;
	readonly privateKey: KeyObject;
}

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function sha256b64url(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("base64url");
}

function is32ByteB64url(value: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").length === 32;
}

/** `b64url(SHA-256(UTF-8(JSON.stringify([title, placeholder ?? null]))))`. */
function secretDisplayHash(title: string, placeholder: string | undefined): string {
	return sha256b64url(JSON.stringify([title, placeholder ?? null]));
}

/** Builds `B`; refuses a deadline that is not a safe integer and any key or hash that is not 32 base64url bytes. */
export function secretBinding(input: SecretBindingInput): SecretBinding {
	const displayHash = secretDisplayHash(input.title, input.placeholder);
	if (!Number.isSafeInteger(input.deadlineAtMs) || ![input.hostJkt, input.hpkePk].every(is32ByteB64url))
		throw new Error("secret_binding_malformed");
	return [
		"omo-secret-binding-v1",
		input.hostInstance,
		input.hostJkt,
		input.durableSessionId,
		input.uiRequestId,
		input.deadlineAtMs,
		input.hpkePk,
		displayHash,
	];
}

/** The host key signs exactly this: `"omo-secret-request-v1\n" + JSON.stringify(B)`. */
export function secretRequestTranscript(binding: SecretBinding): string {
	return `omo-secret-request-v1\n${JSON.stringify(binding)}`;
}

/** A fresh request key, held only by the pending request that owns the latch (design 4.1). */
export function generateSecretRequestKey(): SecretRequestKey {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	const { x } = publicKey.export({ format: "jwk" });
	if (typeof x !== "string") throw new Error("secret_request_key_unavailable");
	return { hpkePk: b64url(Buffer.from(x, "base64url")), privateKey };
}
