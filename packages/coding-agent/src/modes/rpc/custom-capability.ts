/**
 * The `custom_unsupported` capability gate (plan tasks 13/14).
 *
 * In RPC mode `ctx.ui.custom` cannot render a third-party component — there is no
 * TUI to render it FROM. Historically it returned `undefined` synchronously with
 * NO wire message, so a default RPC client saw nothing at all. A client that
 * can present a native "this extension UI requires the classic TUI" notice opts
 * in via a capability flag.
 *
 * This gate is a PURE function so the additive-only guarantee is unit-provable:
 * only a client that advertised the `custom_unsupported` capability gets the
 * additive `extension_ui_request{method:"custom_unsupported"}` notice; every
 * other (default) client gets `undefined` — byte-identical to the prior
 * behavior, no extra bytes on the wire.
 */

import * as crypto from "node:crypto";
import type { RpcExtensionUIRequest } from "./rpc-types.ts";

/** The capability string a client sends in its handshake to opt into the notice. */
export const CUSTOM_UNSUPPORTED_CAPABILITY = "custom_unsupported";

/**
 * Env var carrying client capabilities to a single-connection stdio RPC host
 * (comma-separated). A launcher may set it from a client handshake; a plain
 * stdio client leaves it unset and sees byte-identical default behavior.
 */
export const RPC_CLIENT_CAPABILITIES_ENV = "SENPI_RPC_CLIENT_CAPABILITIES";

/** Parse the comma-separated capabilities env value into a trimmed list. */
export function parseClientCapabilities(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Fallback label when the calling extension's name cannot be determined. */
export const DEFAULT_CUSTOM_EXTENSION_LABEL = "custom UI component";

/**
 * Build the additive `custom_unsupported` request for a `ctx.ui.custom` call, or
 * `undefined` when the client did not opt in.
 *
 * Returning `undefined` is the load-bearing default-client path: the caller must
 * emit NOTHING in that case, preserving the exact prior wire behavior.
 */
export function buildCustomUnsupportedRequest(
	capabilities: readonly string[] | undefined,
	extensionName: string,
): RpcExtensionUIRequest | undefined {
	if (!capabilities?.includes(CUSTOM_UNSUPPORTED_CAPABILITY)) {
		return undefined;
	}
	const name = extensionName.trim() || DEFAULT_CUSTOM_EXTENSION_LABEL;
	return {
		type: "extension_ui_request",
		id: crypto.randomUUID(),
		method: "custom_unsupported",
		extensionName: name,
	};
}
