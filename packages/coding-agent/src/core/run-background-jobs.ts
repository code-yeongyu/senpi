/**
 * The background jobs each turn started (a bash command run with `run_in_background` or one that auto-detached),
 * keyed by the turn id (`turn_epoch`) that was running when the job became background. `interrupt { background:
 * "stop" }` stops the jobs of the turn it interrupted, so nothing that turn left running wakes the session later.
 * A job leaves the registry when it ends on its own (`release`) or once it is stopped.
 */

/** A job the turn started; `stop` ends it without waking the session and rejects with the reason it could not. */
export interface RunBackgroundJob {
	readonly kind: "bash";
	readonly id: string;
	readonly description?: string;
	stop(turnId: string): Promise<void>;
}

export interface StoppedRunBackgroundJob {
	readonly kind: RunBackgroundJob["kind"];
	readonly id: string;
	readonly description?: string;
}

export interface FailedRunBackgroundJob extends StoppedRunBackgroundJob {
	readonly reason: string;
}

/** What `interrupt { background: "stop" }` stopped, and each job it could not stop with the reason. */
export interface RunBackgroundStopOutcome {
	readonly stopped: readonly StoppedRunBackgroundJob[];
	readonly failed: readonly FailedRunBackgroundJob[];
}

function named(job: RunBackgroundJob): StoppedRunBackgroundJob {
	return { kind: job.kind, id: job.id, ...(job.description === undefined ? {} : { description: job.description }) };
}

export class RunBackgroundJobs {
	readonly #byTurn = new Map<string, Set<RunBackgroundJob>>();

	/** Record `job` under `turnId`; the returned release drops it once it ended on its own. */
	register(turnId: string, job: RunBackgroundJob): () => void {
		let jobs = this.#byTurn.get(turnId);
		if (jobs === undefined) {
			jobs = new Set();
			this.#byTurn.set(turnId, jobs);
		}
		jobs.add(job);
		return () => this.#drop(turnId, job);
	}

	/** Stops the turn's jobs all at once, so jobs that ignore TERM cost one grace period, not one each; lists keep start order. */
	async stop(turnId: string): Promise<RunBackgroundStopOutcome> {
		const jobs = [...(this.#byTurn.get(turnId) ?? [])];
		this.#byTurn.delete(turnId);
		const results = await Promise.allSettled(jobs.map(async (job) => job.stop(turnId)));
		const stopped: StoppedRunBackgroundJob[] = [];
		const failed: FailedRunBackgroundJob[] = [];
		jobs.forEach((job, index) => {
			const result = results[index];
			if (result?.status === "fulfilled") {
				stopped.push(named(job));
				return;
			}
			const error: unknown = result?.reason;
			failed.push({ ...named(job), reason: error instanceof Error ? error.message : String(error) });
		});
		return { stopped, failed };
	}

	#drop(turnId: string, job: RunBackgroundJob): void {
		const jobs = this.#byTurn.get(turnId);
		if (jobs === undefined) return;
		jobs.delete(job);
		if (jobs.size === 0) this.#byTurn.delete(turnId);
	}
}
