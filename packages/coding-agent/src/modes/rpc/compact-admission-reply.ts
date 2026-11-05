import { AsyncLocalStorage } from "node:async_hooks";
import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import type { RpcCommand } from "./rpc-types.ts";

export interface AdmissionReplyScope {
	readonly id?: string;
	readonly admissionId?: string;
	readonly peer?: string;
}
const requests = new AsyncLocalStorage<{
	readonly command: Pick<RpcCommand, "id" | "admissionId">;
	readonly peer: string | undefined;
}>();

/** Bounded reply identity, not the command body or a retained request index, crosses an isolate. */
export function captureAdmissionReply(): AdmissionReplyScope | undefined {
	const scope = requests.getStore();
	return scope && { id: scope.command.id, admissionId: scope.command.admissionId, peer: scope.peer };
}
export function withAdmissionReply<T>(scope: AdmissionReplyScope | undefined, action: () => T): T {
	return scope === undefined ? action() : requests.run({ command: scope, peer: scope.peer }, action);
}

/** Request scope, not a retained request index: async session replies keep their caller's route. */
export function withAdmissionRequest<T>(command: RpcCommand, peer: string | undefined, action: () => T): T {
	if (!compactUpdatesEnabled()) return action();
	return requests.run({ command, peer }, action);
}

export function replyAdmission(
	id: string,
	peer: string | undefined,
	routes: readonly string[],
): string | null | undefined {
	const request = requests.getStore();
	// No matching request scope means ownership cannot be proved. Drop (null), never guess routes[0];
	// undefined is reserved for a matching legacy request that did not select an admission.
	if (!request || request.command.id !== id || request.peer !== peer) return null;
	const admissionId = request.command.admissionId;
	return admissionId === undefined ? undefined : (routes.find((route) => route === admissionId) ?? null);
}
