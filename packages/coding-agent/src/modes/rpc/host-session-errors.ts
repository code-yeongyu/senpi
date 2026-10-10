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

export function mapError(error: unknown, socket: string): HostOutcome {
	const detail = error instanceof Error ? error.message : String(error);
	if (error instanceof RpcCommandError) {
		const reason = error.errorCode ?? codeFromMessage(detail);
		const exitCode = USAGE_CODES.has(reason)
			? HOST_EXIT_USAGE
			: FAILURE_CODES.has(reason)
				? HOST_EXIT_ERROR
				: HOST_EXIT_REFUSED;
		return {
			exitCode,
			payload: {
				action: exitCode === HOST_EXIT_REFUSED ? "refuse" : "error",
				reason,
				detail,
				socket,
				...(error.errorData !== undefined && { data: error.errorData }),
			},
		};
	}
	return {
		exitCode: HOST_EXIT_ERROR,
		payload: {
			action: "error",
			reason: isTransportGoneError(error) ? "transport_gone" : "host_error",
			detail,
			socket,
		},
	};
}

function codeFromMessage(message: string): string {
	if (message.startsWith("Model not found:")) return "model_not_found";
	if (message.startsWith("Entry not found:")) return "unknown_cursor";
	if (message.startsWith("Agent is already processing")) return "busy";
	// SessionCommandRouter puts its stable code in `error` when no errorData is needed.
	const code = /^([a-z][a-z_]+)(?::|$)/.exec(message)?.[1];
	if (code) return code;
	return "host_error";
}
