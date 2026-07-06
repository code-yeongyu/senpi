/**
 * Neo daemon handshake protocol.
 *
 * A connection begins with a single `hello` line from the client. The daemon
 * replies with exactly one `welcome` or `refuse` line, then (on welcome) the
 * connection carries the ordinary JSONL RPC protocol for that connection's
 * runtime. The handshake is additive and lives entirely on the socket — it does
 * not touch the existing stdio RPC command shapes.
 */

import { NEO_DAEMON_PROTOCOL_VERSION } from "./neo-daemon-registry.ts";
import type { NeoRuntimeOptions } from "./neo-runtime-options.ts";

/** First line a client sends on a fresh connection. */
export interface NeoHelloMessage {
	readonly type: "hello";
	/** Must match the daemon's registry token. */
	readonly token: string;
	/** Client's protocol version; must equal the daemon's. */
	readonly version: number;
	/** Optional client capability flags (e.g. custom_unsupported opt-in). */
	readonly capabilities?: readonly string[];
	/** Per-connection runtime options used to build THIS connection's runtime. */
	readonly runtimeOptions?: NeoRuntimeOptions;
}

/** Accepted-handshake reply. */
export interface NeoWelcomeMessage {
	readonly type: "welcome";
	readonly version: number;
	/** Capabilities the daemon acknowledges for this connection. */
	readonly capabilities?: readonly string[];
}

/** Rejected-handshake reply. The client then falls back to isolated transport. */
export interface NeoRefuseMessage {
	readonly type: "refuse";
	readonly reason: string;
	readonly code: NeoRefuseCode;
}

export type NeoRefuseCode = "bad_token" | "version_mismatch" | "unsupported_options" | "malformed_hello";

export type NeoDaemonHandshakeReply = NeoWelcomeMessage | NeoRefuseMessage;

/** Parse an inbound first line as a hello message, or return undefined. */
export function parseHello(line: string): NeoHelloMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "hello") return undefined;
	if (typeof record.token !== "string") return undefined;
	if (typeof record.version !== "number") return undefined;
	if (record.capabilities !== undefined && !isStringArray(record.capabilities)) return undefined;
	if (
		record.runtimeOptions !== undefined &&
		(typeof record.runtimeOptions !== "object" || record.runtimeOptions === null)
	) {
		return undefined;
	}
	return {
		type: "hello",
		token: record.token,
		version: record.version,
		capabilities: record.capabilities as string[] | undefined,
		runtimeOptions: record.runtimeOptions as NeoRuntimeOptions | undefined,
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate a hello against the daemon's token/version. Returns a refuse reply
 * on mismatch, or undefined when the handshake is acceptable. `runtimeOptions`
 * validation (unsupported/incompatible flags) is delegated to the caller since
 * it depends on which options the daemon can honor.
 */
export function validateHello(
	hello: NeoHelloMessage,
	expected: { token: string; version?: number },
): NeoRefuseMessage | undefined {
	const version = expected.version ?? NEO_DAEMON_PROTOCOL_VERSION;
	if (hello.version !== version) {
		return {
			type: "refuse",
			code: "version_mismatch",
			reason: `Protocol version mismatch: daemon speaks ${version}, client sent ${hello.version}`,
		};
	}
	if (hello.token !== expected.token) {
		return { type: "refuse", code: "bad_token", reason: "Invalid handshake token" };
	}
	return undefined;
}
