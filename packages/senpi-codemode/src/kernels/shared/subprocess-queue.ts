import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { KernelResult, KernelRunInput, ToolCallMessage } from "./subprocess-contract.ts";
import { createPendingRun, failureResult, type PendingRun, settlePendingRun } from "./subprocess-run.ts";

// Same bound as the JS kernel's pull-API fallback queue (context-manager.ts); clears happen at run teardown.
const MAX_PENDING_TOOL_CALLS = 256;

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
		next?.input.onStarted?.();
		return next;
	}

	remove(cellId: string, reason = "interrupted"): boolean {
		const index = this.#queue.findIndex((run) => run.input.cellId === cellId);
		if (index < 0) return false;
		const [run] = this.#queue.splice(index, 1);
		if (!run) return false;
		this.settle(run, failureResult(run, new Error(reason)));
		return true;
	}

	snapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] } {
		return {
			activeCellId: this.#active?.input.cellId ?? null,
			queuedCellIds: this.#queue.map((run) => run.input.cellId),
		};
	}

	/** Removes every queued run that has not started, oldest first. */
	drain(): PendingRun[] {
		return this.#queue.splice(0);
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
		else {
			this.#pendingCalls.push(message);
			if (this.#pendingCalls.length > MAX_PENDING_TOOL_CALLS) this.#pendingCalls.shift();
		}
	}

	handleMessage(
		message: KernelToHostMessage,
		onMessage: ((message: KernelToHostMessage) => void) | undefined,
	): boolean {
		switch (message.type) {
			case "result": {
				const run = this.#active;
				if (!run || run.input.cellId !== message.cellId) return false;
				(run.input.onMessage ?? onMessage)?.(message);
				this.releaseActive(run);
				this.settle(run, message);
				return true;
			}
			case "tool-call":
				if (!this.#active) return false;
				(this.#active.input.onMessage ?? onMessage)?.(message);
				this.pushToolCall(message);
				return false;
			case "text":
			case "display":
			case "log":
			case "phase":
			case "status":
				if (this.#active) (this.#active.input.onMessage ?? onMessage)?.(message);
				return false;
			case "ready":
			case "init-failed":
			case "closed":
			case "kernel-tool-describe-reply":
			case "kernel-tool-invoke-reply":
				onMessage?.(message);
				return false;
			case "webview-connect":
			case "memory-query-result":
			case "kernel-tools-defined":
				return false;
			default: {
				const exhaustive: never = message;
				return exhaustive;
			}
		}
	}
}
