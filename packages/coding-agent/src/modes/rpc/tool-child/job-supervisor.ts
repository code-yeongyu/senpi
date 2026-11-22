/**
 * Applies the job policy to one live tool child (senpi#3566, plan todo 6): each job's server backstop, the cancel
 * ladder (cancel -> 5 s -> TERM -> 2 s -> KILL) and control liveness (a ping every 5 s while a job is pending; three
 * missed pongs end the child). Timers are injected, so every rule is exact under a fake clock.
 */
import { CANCEL_LADDER, Liveness, MISSED_PONGS_LIMIT, PING_INTERVAL_MS } from "./job-policy.ts";

export interface SupervisedChild {
	sendCancel(jobId: string): void;
	sendPing(seq: number): void;
	/** TERM ends the child gracefully (Windows: the job is terminated); KILL ends it at once. */
	signal(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface SupervisorTimers {
	set(fn: () => void, ms: number): () => void;
}

export const REAL_TIMERS: SupervisorTimers = {
	set: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

export class JobSupervisorError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "JobSupervisorError";
		this.code = code;
	}
}

interface TrackedJob {
	readonly reject: (error: Error) => void;
	readonly cancelTimers: Array<() => void>;
	readonly ladderTimers: Array<() => void>;
	laddered: boolean;
}

export class JobSupervisor {
	readonly #child: SupervisedChild;
	readonly #timers: SupervisorTimers;
	readonly #jobs = new Map<string, TrackedJob>();
	readonly #liveness = new Liveness();
	#nextPing = 0;
	#stopPings: (() => void) | undefined;
	#ended = false;

	constructor(child: SupervisedChild, timers: SupervisorTimers = REAL_TIMERS) {
		this.#child = child;
		this.#timers = timers;
	}

	/** Starts supervising a job; `settle` must be called when its result, error or refusal arrives. */
	track(
		jobId: string,
		options: {
			readonly reject: (error: Error) => void;
			readonly backstopMs: number | undefined;
			readonly userText: string;
			readonly signal?: AbortSignal;
		},
	): void {
		const job: TrackedJob = { reject: options.reject, cancelTimers: [], ladderTimers: [], laddered: false };
		this.#jobs.set(jobId, job);
		if (options.backstopMs !== undefined) {
			job.cancelTimers.push(
				this.#timers.set(() => {
					job.reject(new JobSupervisorError("tool_child_deadline", options.userText));
					this.#cancel(jobId, job);
				}, options.backstopMs),
			);
		}
		const onAbort = () => this.#cancel(jobId, job);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		job.cancelTimers.push(() => options.signal?.removeEventListener("abort", onAbort));
		this.#ensurePinging();
	}

	settle(jobId: string): void {
		const job = this.#jobs.get(jobId);
		if (job === undefined) return;
		this.#jobs.delete(jobId);
		for (const cancel of [...job.cancelTimers, ...job.ladderTimers]) cancel();
		if (this.#jobs.size === 0) this.#stopPinging();
	}

	/** The child acted on the cancel: the ladder stops; the job settles on its own, still under its backstop. */
	cancelAcked(jobId: string): void {
		const job = this.#jobs.get(jobId);
		if (job === undefined) return;
		for (const cancel of job.ladderTimers.splice(0)) cancel();
	}

	pongReceived(): void {
		this.#liveness.pongReceived();
	}

	/** The child is gone: stop every timer; pending jobs are rejected by the caller's exit handling. */
	end(): void {
		this.#ended = true;
		this.#stopPinging();
		for (const job of this.#jobs.values()) for (const cancel of [...job.cancelTimers, ...job.ladderTimers]) cancel();
		this.#jobs.clear();
	}

	#cancel(jobId: string, job: TrackedJob): void {
		if (job.laddered || this.#ended) return;
		job.laddered = true;
		this.#child.sendCancel(jobId);
		for (const rung of CANCEL_LADDER)
			job.ladderTimers.push(
				this.#timers.set(() => this.#child.signal(rung.step === "term" ? "SIGTERM" : "SIGKILL"), rung.atMs),
			);
	}

	#ensurePinging(): void {
		if (this.#stopPings !== undefined || this.#ended) return;
		const tick = () => {
			if (this.#liveness.unresponsive()) {
				const failure = new JobSupervisorError(
					"tool_child_unresponsive",
					`the tool child missed ${MISSED_PONGS_LIMIT} pings`,
				);
				for (const job of this.#jobs.values()) job.reject(failure);
				this.#child.signal("SIGKILL");
				this.end();
				return;
			}
			this.#liveness.pingSent();
			this.#child.sendPing(++this.#nextPing);
			this.#stopPings = this.#timers.set(tick, PING_INTERVAL_MS);
		};
		this.#stopPings = this.#timers.set(tick, PING_INTERVAL_MS);
	}

	#stopPinging(): void {
		this.#stopPings?.();
		this.#stopPings = undefined;
	}
}
