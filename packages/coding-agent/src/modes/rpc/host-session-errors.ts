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
		const code = error.errorCode ?? (BARE_CODE.test(detail) ? detail : undefined);
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

function hostError(detail: string, socket: string): HostOutcome {
	return { exitCode: HOST_EXIT_ERROR, payload: { action: "error", reason: "host_error", detail, socket } };
}
