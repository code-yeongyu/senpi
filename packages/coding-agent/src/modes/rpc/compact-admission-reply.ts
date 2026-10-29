import { AsyncLocalStorage } from "node:async_hooks";
import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import type { RpcCommand } from "./rpc-types.ts";

const requests = new AsyncLocalStorage<{ readonly command: RpcCommand; readonly peer: string | undefined }>();

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
