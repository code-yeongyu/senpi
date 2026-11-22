import { HOST_EXIT_ERROR, HOST_EXIT_REFUSED, HOST_EXIT_USAGE, type HostOutcome } from "./host-outcome.ts";
import { isTransportGoneError, RpcCommandError } from "./rpc-client.ts";

const USAGE_CODES = new Set([
	"missing_session_id",
	"invalid_path",
	"invalid_session_context",
	"invalid_session_kind",
	"invalid_launch_profile",
	"invalid_session_id",
	"invalid_release_reason",
	"empty",
	"unknown_command",
]);
const FAILURE_CODES = new Set(["open_failed", "warm_failed", "release_failed"]);
const REASON_FOR_CODE: Readonly<Record<string, string>> = { streaming: "busy", not_found: "unknown_cursor" };
/** The session router answers with its bare stable code as the whole `error` string. */
const BARE_CODE = /^[a-z][a-z0-9_]*$/;

export function mapError(error: unknown, socket: string): HostOutcome {
	const detail = error instanceof Error ? error.message : String(error);
	if (error instanceof RpcCommandError) {
		const code = stableCode(error.errorCode, detail);
		if (code === undefined) return hostError(detail, socket);
		const exitCode = USAGE_CODES.has(code)
			? HOST_EXIT_USAGE
			: FAILURE_CODES.has(code)
				? HOST_EXIT_ERROR
				: HOST_EXIT_REFUSED;
		return {
			exitCode,
			payload: {
				action: exitCode === HOST_EXIT_REFUSED ? "refuse" : "error",
				reason: REASON_FOR_CODE[code] ?? code,
				detail,
				socket,
				...(error.errorData !== undefined && { data: error.errorData }),
			},
		};
	}
	if (isTransportGoneError(error)) {
		return { exitCode: HOST_EXIT_ERROR, payload: { action: "error", reason: "transport_gone", detail, socket } };
	}
	return hostError(detail, socket);
}

/**
 * The code an exit maps on. A refusal may carry its detail after the code (`invalid_launch_profile: <detail>`), in
 * `errorCode` or in the message alone; the stable code is the part before the first `: ` (senpi#3283). Prose with no
 * code stays unmapped, except that a usage refusal's own prefix still names its usage code.
 */
function stableCode(errorCode: string | undefined, detail: string): string | undefined {
	if (errorCode !== undefined) return codePrefix(errorCode);
	if (BARE_CODE.test(detail)) return detail;
	const prefix = codePrefix(detail);
	return USAGE_CODES.has(prefix) ? prefix : undefined;
}

function codePrefix(text: string): string {
	const end = text.indexOf(": ");
	return end === -1 ? text : text.slice(0, end);
}

function hostError(detail: string, socket: string): HostOutcome {
	return { exitCode: HOST_EXIT_ERROR, payload: { action: "error", reason: "host_error", detail, socket } };
}
