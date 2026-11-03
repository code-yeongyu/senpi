import { threadId } from "node:worker_threads";
/**
 * The execution barrier inside a tool-child worker thread (senpi#3566, plan todo 4).
 *
 * A worker claims a slot on the shared barrier clock itself, asks the protocol loop (main thread) to send `launch`,
 * and blocks on `Atomics.wait` until the loop records the server's ack in that slot. Only then does it store the
 * invoke tick and call the real API. Blocking the worker is what makes every API - synchronous ones included - safe:
 * nothing can run, and no caller can write to a shim's stdin, before the ack. The main thread stays free throughout,
 * so it can receive the ack and publish the proof even while the command itself blocks this worker.
 */
import { BarrierClock } from "./barrier-clock.ts";
import type { LaunchRequest } from "./launch-gate.ts";

export type WorkerLaunchMessage =
	| { readonly kind: "launch"; readonly launchId: string; readonly slot: number; readonly request: LaunchRequest }
	| { readonly kind: "invoking"; readonly launchId: string }
	| { readonly kind: "started"; readonly launchId: string; readonly pid: number; readonly breakaway: boolean }
	| { readonly kind: "done"; readonly launchId: string; readonly exitCode?: number; readonly signal?: string };

export interface WorkerLaunchClientOptions {
	readonly clockBuffer: SharedArrayBuffer;
	readonly post: (message: WorkerLaunchMessage) => void;
	readonly jobId: () => string;
	/** Test-only `SKIP_ACK_WAIT` mutation. */
	readonly skipAckWait?: boolean;
	/** Bounded wait for the ack; the server kills the child long before this in practice. */
	readonly ackTimeoutMs?: number;
	/** The worker's identity inside launch ids; the worker thread id by default. */
	readonly workerId?: number;
}

export class WorkerLaunchError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "WorkerLaunchError";
		this.code = code;
	}
}

export class WorkerLaunchClient {
	readonly #clock: BarrierClock;
	readonly #options: WorkerLaunchClientOptions;
	#next = 0;

	constructor(options: WorkerLaunchClientOptions) {
		this.#clock = new BarrierClock(options.clockBuffer);
		this.#options = options;
	}

	/** Sends `launch` and blocks this worker until the ack; returns the launch id for `invoke`/`done`. */
	acquire(request: Omit<LaunchRequest, "jobId">): string {
		const slot = this.#clock.claimSlot();
		if (slot === undefined)
			throw new WorkerLaunchError("tool_child_launch_capacity", `${this.#clock.slots} launches in flight`);
		// Worker threads share the pid and each job's worker starts its own counter: the thread id keeps ids unique
		// across every worker of a generation.
		const launchId = `W${process.pid}-${this.#options.workerId ?? threadId}-${slot}-${++this.#next}`;
		this.#options.post({ kind: "launch", launchId, slot, request: { ...request, jobId: this.#options.jobId() } });
		if (this.#options.skipAckWait !== true) {
			if (this.#clock.waitForAck(slot, this.#options.ackTimeoutMs ?? 60_000) === "timed-out") {
				throw new WorkerLaunchError("tool_child_launch_unacknowledged", launchId);
			}
		}
		this.#slotOf.set(launchId, slot);
		return launchId;
	}

	/** Immediately before the real call: store the invoke tick and let the protocol loop publish the proof. */
	invoke(launchId: string): void {
		const slot = this.#slotOf.get(launchId);
		if (slot === undefined) throw new WorkerLaunchError("tool_child_launch_unknown", launchId);
		this.#clock.recordInvoke(slot);
		this.#options.post({ kind: "invoking", launchId });
	}

	/** Windows: the command's pid once the real call returned it, for the server's creation-time membership record. */
	started(launchId: string, pid: number, breakaway = false): void {
		this.#options.post({ kind: "started", launchId, pid, breakaway });
	}

	done(launchId: string, outcome: { readonly exitCode?: number | null; readonly signal?: string | null }): void {
		this.#slotOf.delete(launchId);
		this.#options.post({
			kind: "done",
			launchId,
			...(outcome.exitCode === undefined || outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
			...(outcome.signal === undefined || outcome.signal === null ? {} : { signal: outcome.signal }),
		});
	}

	readonly #slotOf = new Map<string, number>();
}
