import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { parsePermissionPresetName } from "../../core/extensions/builtin/permission-system/cli.ts";
import { permissionModeOf, permissionModeReply } from "../../core/permission-mode.ts";
import { RPC_ERROR_INVALID_LAUNCH_PROFILE, type RpcCommand, type RpcResponse } from "./rpc-types.ts";

// The live setter a classic `--mode rpc` session has no other way to receive (it refuses `open_session`), and the
// path-free one for a session on another device. An unknown preset is refused before anything changes, so the
// session keeps the mode it had; a valid one is applied through the runtime the way an attach naming it applies it.
export function runSetPermissionPreset(
	runtime: Pick<AgentSessionRuntime, "session" | "setPermissionPreset">,
	command: Extract<RpcCommand, { type: "set_permission_preset" }>,
): RpcResponse {
	if (parsePermissionPresetName(command.permissionPreset) === undefined) {
		return {
			id: command.id,
			type: "response",
			command: "set_permission_preset",
			success: false,
			error: `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: unknown permissionPreset "${command.permissionPreset}"`,
			errorCode: RPC_ERROR_INVALID_LAUNCH_PROFILE,
		};
	}
	runtime.setPermissionPreset(command.permissionPreset);
	return {
		id: command.id,
		type: "response",
		command: "set_permission_preset",
		success: true,
		data: permissionModeReply(permissionModeOf(runtime.session)),
	};
}
