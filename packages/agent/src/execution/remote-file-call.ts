import type { AgentToolResult } from "../types.ts";
import type { DeviceFileErrorCode, DeviceFileOutcome } from "./device-files.ts";
import type { RemoteFile, RemoteInvoke } from "./remote-protocol.ts";

/**
 * A device file operation as the hand's admission sees it (S40): the same record an invoke has, so the operation goes
 * through the same lane, grant, scope binding, execution ID and durable-ledger checks. The name is never a tool's: the
 * hand chose the file path from the message kind, and an invoke carrying this name is an unknown tool.
 */
export function fileCall(message: RemoteFile): RemoteInvoke {
	return {
		kind: "invoke",
		executionId: message.executionId,
		batchId: message.executionId,
		index: 0,
		scope: message.scope,
		toolCallId: message.executionId,
		name: `file.${message.op}`,
		arguments: message.args,
	};
}

export function fileResult(outcome: DeviceFileOutcome): AgentToolResult<unknown> {
	return { content: [], details: { file: outcome }, isError: !outcome.ok };
}

export function fileRefusal(code: DeviceFileErrorCode, message: string): AgentToolResult<unknown> {
	return fileResult({ ok: false, code, message });
}

/** An operation that ended aborted: a refusal when its grant no longer holds, never any data. */
export function fileStopped(granted: boolean): AgentToolResult<unknown> {
	return granted
		? fileRefusal("aborted", "the operation was aborted")
		: fileRefusal("refused_by_grant", "the grant was revoked");
}
