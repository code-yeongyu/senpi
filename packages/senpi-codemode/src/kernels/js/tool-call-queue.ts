import type { ToolCallMessage } from "./kernel-contract.ts";

// Pull-API fallback queue bound: a nextToolCall consumer this far behind is already stalled, and the
// normal push path (onMessage) never reads the queue, so unbounded growth only pins tool args (#1695).
const MAX_PENDING_TOOL_CALLS = 256;

/** Tool calls for `nextToolCall()` consumers: handed to a waiting consumer, else queued up to the bound. */
export class ToolCallQueue {
	readonly #waiters: Array<(message: ToolCallMessage) => void> = [];
	readonly #pending: ToolCallMessage[] = [];

	push(message: ToolCallMessage): void {
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter(message);
			return;
		}
		this.#pending.push(message);
		if (this.#pending.length > MAX_PENDING_TOOL_CALLS) this.#pending.shift();
	}

	async next(): Promise<ToolCallMessage> {
		const pending = this.#pending.shift();
		if (pending) return pending;
		return await new Promise((resolve) => this.#waiters.push(resolve));
	}

	clear(): void {
		this.#pending.length = 0;
		this.#waiters.length = 0;
	}
}
