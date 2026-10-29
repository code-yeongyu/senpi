import { AsyncLocalStorage } from "node:async_hooks";
import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import type { RpcCommand } from "./rpc-types.ts";

const requests = new AsyncLocalStorage<{ readonly command: RpcCommand; readonly peer: string | undefined }>();

/** Request scope, not a retained request index: async session replies keep their caller's route. */
export function withAdmissionRequest<T>(command: RpcCommand, peer: string | undefined, action: () => T): T {
	if (!compactUpdatesEnabled()) return action();
	return requests.run({ command, peer }, action);
}

export function replyAdmission(id: string, peer: string | undefined, routes: readonly string[]): string | undefined {
	const request = requests.getStore();
	if (!request || request.command.id !== id) return routes[0];
	if (request.peer !== peer) return undefined;
	const admissionId = request.command.admissionId;
	return admissionId === undefined ? routes[0] : routes.find((route) => route === admissionId);
}
