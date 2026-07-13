import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { KernelResult, KernelRunInput, ToolCallMessage } from "./subprocess-contract.ts";
import { createPendingRun, failureResult, type PendingRun, settlePendingRun } from "./subprocess-run.ts";

export class SubprocessRunQueue {
	readonly #queue: PendingRun[] = [];
	readonly #pendingCalls: ToolCallMessage[] = [];
	readonly #callWaiters: Array<(message: ToolCallMessage) => void> = [];
	#active: PendingRun | null = null;

	get active(): PendingRun | null {
		return this.#active;
	}

	enqueue(input: KernelRunInput): Promise<KernelResult> {
		return new Promise((resolve) => this.#queue.push(createPendingRun(input, resolve)));
	}

	startNext(startedAt: number): PendingRun | null {
		if (this.#active) return null;
		const next = this.#queue.shift() ?? null;
		if (next) next.startedAt = startedAt;
		this.#active = next;
		return next;
	}

	takeWaiting(): PendingRun | null {
		return this.#queue.shift() ?? null;
	}

	releaseActive(run: PendingRun): boolean {
		if (this.#active !== run) return false;
		this.#active = null;
		return true;
	}

	settle(run: PendingRun, result: KernelResult): void {
		if (settlePendingRun(run, result) && this.#active === run) this.#active = null;
	}

	settleAll(error: Error): void {
		const runs = this.#active ? [this.#active, ...this.#queue] : [...this.#queue];
		this.#active = null;
		this.#queue.length = 0;
		for (const run of runs) this.settle(run, failureResult(run, error));
	}

	clearToolCalls(): void {
		this.#pendingCalls.length = 0;
		this.#callWaiters.length = 0;
	}

	nextToolCall(): Promise<ToolCallMessage> {
		const queued = this.#pendingCalls.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => this.#callWaiters.push(resolve));
	}

	pushToolCall(message: ToolCallMessage): void {
		const waiter = this.#callWaiters.shift();
		if (waiter) waiter(message);
		else this.#pendingCalls.push(message);
	}

	handleMessage(
		message: KernelToHostMessage,
		onMessage: ((message: KernelToHostMessage) => void) | undefined,
	): boolean {
		switch (message.type) {
			case "result": {
				const run = this.#active;
				if (!run || run.input.cellId !== message.cellId) return false;
				onMessage?.(message);
				this.releaseActive(run);
				this.settle(run, message);
				return true;
			}
			case "tool-call":
				if (!this.#active) return false;
				onMessage?.(message);
				this.pushToolCall(message);
				return false;
			case "text":
			case "display":
			case "log":
			case "phase":
			case "status":
				if (this.#active) onMessage?.(message);
				return false;
			case "ready":
			case "init-failed":
			case "closed":
				onMessage?.(message);
				return false;
			default: {
				const exhaustive: never = message;
				return exhaustive;
			}
		}
	}
}
