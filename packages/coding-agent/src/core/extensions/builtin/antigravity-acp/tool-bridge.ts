import { randomUUID } from "node:crypto";
import type { BridgeCallResult } from "./bridge-server.ts";

export type PendingToolCall = {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
};

type PendingEntry = PendingToolCall & {
	claimed: boolean;
	detaching: boolean;
	signal: AbortSignal;
	onAbort: () => void;
	resolve: (result: BridgeCallResult) => void;
	reject: (error: Error) => void;
};

type AvailabilityWaiter = {
	signal: AbortSignal | undefined;
	onAbort: () => void;
	resolve: () => void;
	reject: (error: Error) => void;
};

export class ToolCallQueue {
	readonly #pending: PendingEntry[] = [];
	readonly #detached = new Set<string>();
	readonly #availabilityWaiters: AvailabilityWaiter[] = [];

	get size(): number {
		return this.#pending.length;
	}

	get detachedCount(): number {
		return this.#detached.size;
	}

	enqueue(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeCallResult> {
		if (signal.aborted) return Promise.reject(abortError(signal));

		const toolCallId = `agy_${randomUUID()}`;
		return new Promise<BridgeCallResult>((resolve, reject) => {
			const entry: PendingEntry = {
				toolCallId,
				name,
				args,
				claimed: false,
				detaching: false,
				signal,
				onAbort: () => {
					if (!this.#removeEntry(entry)) return;
					if (entry.detaching) {
						this.#detached.add(entry.toolCallId);
					}
					reject(abortError(signal));
				},
				resolve,
				reject,
			};
			this.#pending.push(entry);
			signal.addEventListener("abort", entry.onAbort, { once: true });
			this.#wakeAvailabilityWaiters();
		});
	}

	whenUnclaimed(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError(signal));
		if (this.hasUnclaimed()) return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const waiter: AvailabilityWaiter = {
				signal,
				onAbort: () => {
					const index = this.#availabilityWaiters.indexOf(waiter);
					if (index === -1) return;
					this.#availabilityWaiters.splice(index, 1);
					reject(abortError(signal));
				},
				resolve,
				reject,
			};
			this.#availabilityWaiters.push(waiter);
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}

	takeUnclaimed(): PendingToolCall | undefined {
		const pending = this.#pending.find((entry) => !entry.claimed);
		if (pending === undefined) return undefined;
		pending.claimed = true;
		return toPendingToolCall(pending);
	}

	hasUnclaimed(): boolean {
		return this.#pending.some((entry) => !entry.claimed);
	}

	isPending(toolCallId: string): boolean {
		return this.#pending.some((entry) => entry.toolCallId === toolCallId);
	}

	isDetached(toolCallId: string): boolean {
		return this.#detached.has(toolCallId);
	}

	hasDetached(): boolean {
		return this.#detached.size > 0;
	}

	hasCall(toolCallId: string): boolean {
		return this.isPending(toolCallId) || this.isDetached(toolCallId);
	}

	consumeDetached(toolCallId: string): boolean {
		return this.#detached.delete(toolCallId);
	}

	clearDetached(): void {
		this.#detached.clear();
	}

	beginDetach(): string[] {
		const ids: string[] = [];
		for (const entry of this.#pending) {
			entry.detaching = true;
			this.#detached.add(entry.toolCallId);
			ids.push(entry.toolCallId);
		}
		return ids;
	}

	detachAll(noticeText: string): string[] {
		const result: BridgeCallResult = {
			content: [{ type: "text", text: noticeText }],
			isError: true,
		};
		const ids: string[] = [];
		const entries = this.#pending.splice(0);
		for (const entry of entries) {
			entry.signal.removeEventListener("abort", entry.onAbort);
			this.#detached.add(entry.toolCallId);
			ids.push(entry.toolCallId);
			entry.resolve(result);
		}
		return ids;
	}

	resolve(toolCallId: string, result: BridgeCallResult): boolean {
		const entry = this.#pending.find((candidate) => candidate.toolCallId === toolCallId);
		if (entry === undefined) return false;
		this.#removeEntry(entry);
		entry.resolve(result);
		return true;
	}

	rejectAll(reason: string): void {
		const result: BridgeCallResult = {
			content: [{ type: "text", text: reason }],
			isError: true,
		};
		const entries = this.#pending.splice(0);
		for (const entry of entries) {
			entry.signal.removeEventListener("abort", entry.onAbort);
			entry.resolve(result);
		}
		this.#detached.clear();
	}

	#wakeAvailabilityWaiters(): void {
		if (!this.hasUnclaimed()) return;
		for (const waiter of this.#availabilityWaiters.splice(0)) {
			waiter.signal?.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(abortError(waiter.signal));
				continue;
			}
			waiter.resolve();
		}
	}

	#removeEntry(entry: PendingEntry): boolean {
		const index = this.#pending.indexOf(entry);
		if (index === -1) return false;
		this.#pending.splice(index, 1);
		entry.signal.removeEventListener("abort", entry.onAbort);
		return true;
	}
}

function toPendingToolCall(entry: PendingEntry): PendingToolCall {
	return {
		toolCallId: entry.toolCallId,
		name: entry.name,
		args: entry.args,
	};
}

function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
