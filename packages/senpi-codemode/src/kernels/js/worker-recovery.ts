import type { JavaScriptRunQueue } from "./run-queue.ts";
import { WorkerStartupCancelledError } from "./worker-host.ts";

export interface WorkerRecoveryHost {
	readonly runs: JavaScriptRunQueue;
	isOpen(): boolean;
	ensureReady(): Promise<void>;
	startNext(): void;
}

/** Brings a worker up for waiting cells, and replaces a lost or retired worker one recovery at a time. */
export class WorkerRecovery {
	readonly #host: WorkerRecoveryHost;
	#recovery: Promise<void> | null = null;

	constructor(host: WorkerRecoveryHost) {
		this.#host = host;
	}

	get inFlight(): Promise<void> | null {
		return this.#recovery;
	}

	/** Starts a worker when none is live and hands it the next waiting cell; a failed start fails the waiting cells. */
	async bringUp(): Promise<void> {
		try {
			await this.#host.ensureReady();
			if (this.#host.isOpen()) this.#host.startNext();
		} catch (error) {
			this.#failWaiting(error);
		}
	}

	/** Retires through `retire` (a no-op when the worker is already gone), then brings a fresh worker up. */
	async recover(retire: () => Promise<unknown>): Promise<void> {
		if (this.#recovery) return await this.#recovery;
		const recovery = this.#perform(retire);
		this.#recovery = recovery;
		try {
			await recovery;
		} finally {
			if (this.#recovery === recovery) this.#recovery = null;
		}
	}

	async #perform(retire: () => Promise<unknown>): Promise<void> {
		try {
			await retire();
		} catch (error) {
			this.#failWaiting(error);
			return;
		}
		if (this.#host.isOpen()) await this.bringUp();
	}

	#failWaiting(error: unknown): void {
		if (error instanceof WorkerStartupCancelledError) return;
		this.#host.runs.rejectWaiting(error instanceof Error ? error : new Error(String(error)));
	}
}
