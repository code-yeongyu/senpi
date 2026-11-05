import type { RpcResponse } from "./rpc-types.ts";

type PendingReply = {
	readonly onResponse?: (response: RpcResponse) => void;
	readonly resolve: (response: RpcResponse) => void;
};

/** Responses are never events. Dispatch hooks before resolving, so the next frame sees their effects. */
/**
 * The ids this client wrote without waiting for a reply (`extension_ui_response`, `extension_ui_progress`), counted
 * per id because a draft is sent many times under its dialog's id. The engine answers each, so its reply is consumed
 * here rather than reported as dropped (senpi#5761). Bounded: an engine that never replies cannot grow it.
 */
export class UnawaitedReplies {
	private readonly counts = new Map<string, number>();
	private readonly max: number;
	constructor(max = 1024) {
		this.max = max;
	}
	note(id: string): void {
		this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
		for (const oldest of this.counts.keys()) {
			if (this.counts.size <= this.max) break;
			this.counts.delete(oldest);
		}
	}
	take(id: string): boolean {
		const count = this.counts.get(id);
		if (count === undefined) return false;
		if (count <= 1) this.counts.delete(id);
		else this.counts.set(id, count - 1);
		return true;
	}
}

export function handleRpcReply<T extends PendingReply>(
	value: unknown,
	requests: Map<string, T>,
	admissions: { receive(input: unknown): void },
	unawaited?: UnawaitedReplies,
): boolean {
	if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "response") return false;
	const id = "id" in value && typeof value.id === "string" ? value.id : undefined;
	const pending = id === undefined ? undefined : requests.get(id);
	if (pending === undefined && id !== undefined && unawaited?.take(id) === true) return true;
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
