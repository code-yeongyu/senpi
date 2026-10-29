import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { attachmentGate } from "./session-attachment-gate.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";
import { transferSealRefusal } from "./session-transfer-seal.ts";

/**
 * What the router answers before it routes `command`: `undefined` routes it, `{ answer }` answers it now. A
 * parked handle's answer is `undefined` on purpose: its terminal record and connection close answer it.
 */
export function admissionAnswer(
	host: RouterContext,
	command: RpcCommand,
): { readonly answer: RpcResponse | undefined } | undefined {
	const refusal = attachmentGate(host, command) ?? transferSealRefusal(host, command);
	if (refusal) return { answer: refusal };
	const sessionId = "sessionId" in command ? command.sessionId : undefined;
	if (host.draining && sessionId !== undefined && host.handoffClosed.has(sessionId)) return { answer: undefined };
	if (host.draining && command.type === "open_session")
		return { answer: error(command.id, command.type, "host_draining") };
	return undefined;
}
