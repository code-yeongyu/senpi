import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { attachmentGate } from "./session-attachment-gate.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";
import { handoverSealVerdict, noteApplicationConnection } from "./session-router-handover.ts";
import { transferSealRefusal } from "./session-transfer-seal.ts";

export type Admission = { readonly answer: RpcResponse | undefined } | { readonly hold: Promise<boolean> } | undefined;

/**
 * What the router does with `command` before it routes it: `undefined` routes it, `{ answer }` answers it now, and
 * `{ hold }` admits it again once a handover's publication reached its outcome. A parked handle's answer is
 * `undefined` on purpose: its terminal record and connection close answer it.
 */
export function admissionAnswer(host: RouterContext, command: RpcCommand): Admission {
	const refusal = attachmentGate(host, command) ?? transferSealRefusal(host, command);
	if (refusal) return { answer: refusal };
	const sessionId = "sessionId" in command ? command.sessionId : undefined;
	if (host.draining && sessionId !== undefined && host.handoffClosed.has(sessionId)) return { answer: undefined };
	if (host.draining && command.type === "open_session")
		return { answer: error(command.id, command.type, "host_draining") };
	const seal = handoverSealVerdict(host, command);
	if (seal instanceof Promise) return { hold: seal };
	if (seal !== undefined) return { answer: seal };
	noteApplicationConnection(host, command);
	return undefined;
}
