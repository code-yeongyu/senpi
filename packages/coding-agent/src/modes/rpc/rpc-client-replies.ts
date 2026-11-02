import type { RpcResponse } from "./rpc-types.ts";

type PendingReply = {
	readonly onResponse?: (response: RpcResponse) => void;
	readonly resolve: (response: RpcResponse) => void;
};

/** Responses are never events. Dispatch hooks before resolving, so the next frame sees their effects. */
export function handleRpcReply<T extends PendingReply>(
	value: unknown,
	requests: Map<string, T>,
	admissions: { receive(input: unknown): void },
): boolean {
	if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "response") return false;
	const id = "id" in value && typeof value.id === "string" ? value.id : undefined;
	const pending = id === undefined ? undefined : requests.get(id);
	if (pending === undefined || id === undefined) {
		process.stderr.write("senpi rpc client: dropped response with no pending request\n");
		return true;
	}
	requests.delete(id);
	const response = value as RpcResponse;
	admissions.receive(response);
	pending.onResponse?.(response);
	pending.resolve(response);
	return true;
}
