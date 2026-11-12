import type { HostCoreGate } from "./host-core-gate.ts";
import { errorMessage } from "./host-supervisor-log.ts";
import { RPC_ERROR_INTERNAL } from "./rpc-error-types.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";
import { code, detail, error } from "./session-router-errors.ts";

/**
 * The answer to a host-level command whose handler threw: the registry's own refusal when the error is one, as a
 * session-scoped command already answers it, and `internal_error` with the message for anything else.
 */
function handlerFailure(command: RpcCommand, cause: unknown): RpcResponse {
	return cause instanceof RpcSessionRegistryError
		? error(command.id, command.type, code(cause), detail(cause))
		: error(command.id, command.type, RPC_ERROR_INTERNAL, { detail: errorMessage(cause) });
}

/**
 * Dispatches one parsed command and answers its line. A host-level handler is trusted to catch its own errors, and
 * one that did not used to leave the request with no response at all: the line's rejection went to stderr and the
 * caller waited out its own timeout (senpi#6483). The throw is answered here, the outermost point that still knows
 * the command's id and type; the stderr line stays, and what follows an answered line still runs.
 */
export async function answerLine(
	writer: SessionEventWriter,
	connection: string | undefined,
	gate: Pick<HostCoreGate, "dispatch">,
	command: RpcCommand,
): Promise<void> {
	let response: object | undefined;
	try {
		response = await gate.dispatch(command);
	} catch (cause) {
		const where = connection === undefined ? "stdio request" : `connection ${connection}`;
		process.stderr.write(`senpi rpc ${where} failed: ${errorMessage(cause)}\n`);
		response = handlerFailure(command, cause);
	}
	if (response) await writer.enqueueControl(response);
	writer.delegations.lineAnswered(connection);
}
