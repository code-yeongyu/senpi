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
	| "auth_failed";

export class RpcEndpointAuthError extends Error {
	readonly code: RpcEndpointAuthErrorCode;
	constructor(code: RpcEndpointAuthErrorCode, detail: string, options?: ErrorOptions) {
		super(`${code}: ${detail}`, options);
		this.code = code;
		this.name = "RpcEndpointAuthError";
	}
}

export function authRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}
