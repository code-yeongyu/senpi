import type { CliRuntimeConfiguration } from "../../main.ts";
import { type LooplessWorker, startLooplessWorker } from "./loopless-worker-client.ts";
import { SESSION_WORKER_LIMITS } from "./session-worker-protocol.ts";
import type { WorkerCapacity } from "./worker-capacity.ts";

export interface LooplessWorkerPoolOptions {
	readonly configuration: CliRuntimeConfiguration;
	/** The process's one worker budget; the session registry of the same process shares it. */
	readonly capacity: WorkerCapacity;
	/** Production starts a real isolate; a caller may supply one to drive admission deterministically. */
	readonly createWorker?: () => LooplessWorker;
}

export interface OpenLooplessWorker {
	readonly id: string;
	readonly tools: readonly string[];
}

/**
 * Loopless workers (senpi#5413): one session-worker isolate per session, each hosting a runtime with the agent
 * loop removed. Every worker, opening ones included, counts against the process's worker cap, so a process
 * serving many sessions admits at most `SESSION_WORKER_LIMITS.workers` workers across all of them (Z2).
 */
export class LooplessWorkerPool {
	private readonly workers = new Map<string, LooplessWorker>();
	private readonly options: LooplessWorkerPoolOptions;
	private serial = 0;

	constructor(options: LooplessWorkerPoolOptions) {
		this.options = options;
		options.capacity.track(() => this.workers.size);
	}

	get size(): number {
		return this.workers.size;
	}

	async open(cwd: string): Promise<OpenLooplessWorker> {
		if (this.options.capacity.inUse() >= SESSION_WORKER_LIMITS.workers) throw new Error("too_many_sessions");
		const id = `loopless-${++this.serial}`;
		const worker = (this.options.createWorker ?? startLooplessWorker)();
		this.workers.set(id, worker);
		void worker.exited.then(() => {
			if (this.workers.get(id) === worker) this.workers.delete(id);
		});
		try {
			return { id, tools: await worker.start(this.options.configuration, cwd) };
		} catch (cause) {
			await worker.close();
			this.workers.delete(id);
			throw cause;
		}
	}

	async close(id: string): Promise<void> {
		const worker = this.workers.get(id);
		if (worker === undefined) throw new Error("unknown_session");
		await worker.close();
		this.workers.delete(id);
	}
}
