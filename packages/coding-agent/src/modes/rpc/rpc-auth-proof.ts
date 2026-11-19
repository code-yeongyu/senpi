import { createHmac, timingSafeEqual } from "node:crypto";

export const RPC_AUTH_CAPABILITY = "socket_auth";
export const RPC_AUTH_HEX = /^[a-f0-9]{64}$/;
export const RPC_LAUNCH_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/**
 * The record a public-key filter hands the host core, in band and in order, once its client proved the launch key
 * (senpi#5632). Only a filter writes it: every filter refuses it from a client.
 */
export const RPC_LAUNCH_PROOF_RECORD = "launch_proven";

export function launchProofRecordRefusal(id: unknown): Readonly<Record<string, unknown>> {
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command: RPC_LAUNCH_PROOF_RECORD,
		success: false,
		error: "reserved_record",
		errorCode: "reserved_record",
	};
}

export function rpcAuthProof(key: Uint8Array, label: "server" | "client", ...parts: readonly string[]): string {
	return createHmac("sha256", key)
		.update([`senpi-rpc-${label}`, ...parts].join("\n"), "utf8")
		.digest("hex");
}

export function rpcProofMatches(expected: string, received: unknown): boolean {
	return (
		typeof received === "string" &&
		RPC_AUTH_HEX.test(received) &&
		timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
	);
}

export type RpcEndpointAuthErrorCode =
	| "unsafe_key_record"
	| "host_identity_unproven"
	| "key_publication_failed"
	| "auth_required"
	| "auth_failed"
	| typeof RPC_HOST_OVERLOADED;

/**
 * A supervisor refuses a public challenge its engine has not answered within the budget (senpi#7055), with
 * `errorData.retry_after_ms`, instead of letting the client's own handshake deadline expire in silence.
 */
export const RPC_HOST_OVERLOADED = "host_overloaded";

export class RpcEndpointAuthError extends Error {
	readonly code: RpcEndpointAuthErrorCode;
	/** Set on `host_overloaded`: when a new connection may succeed. */
	readonly retryAfterMs: number | undefined;
	constructor(
		code: RpcEndpointAuthErrorCode,
		detail: string,
		options?: ErrorOptions & { readonly retryAfterMs?: number },
	) {
		super(`${code}: ${detail}`, options);
		this.code = code;
		this.retryAfterMs = options?.retryAfterMs;
		this.name = "RpcEndpointAuthError";
	}
}

/** A pre-admission refusal: the filter's `auth_required`/`auth_failed`, or the supervisor's `host_overloaded`. */
export function authRefusal(
	request: Readonly<Record<string, unknown>> | undefined,
	code: "auth_required" | "auth_failed" | typeof RPC_HOST_OVERLOADED,
	errorData?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return {
		id: request?.id,
		type: "response",
		command: request?.type ?? "parse",
		success: false,
		error: code,
		errorCode: code,
		...(errorData === undefined ? {} : { errorData }),
	};
}

export function authRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

/**
 * A host's successful `get_protocol_info` answer as a public client receives it: `socket_auth` advertised and, for
 * the answer to its challenge, the server's proof of the launch key.
 */
export function challengeAnswer(
	record: Readonly<Record<string, unknown>>,
	challenge: { readonly id: unknown; readonly client: string; readonly server: string } | undefined,
	key: Uint8Array,
	launchId: string,
): Readonly<Record<string, unknown>> {
	const data = authRecord(record.data) ?? {};
	const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
	return {
		...record,
		data: {
			...data,
			capabilities: [...new Set([...capabilities, RPC_AUTH_CAPABILITY])],
			...(challenge && record.id === challenge.id
				? {
						auth: {
							launch_id: launchId,
							server_nonce: challenge.server,
							server_proof: rpcAuthProof(key, "server", launchId, challenge.client, challenge.server),
						},
					}
				: {}),
		},
	};
}
