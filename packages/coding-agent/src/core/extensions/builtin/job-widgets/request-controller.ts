/**
 * The spec requests of one session's jobs: decides when a job is due (`request-policy.ts`), sends
 * the redacted request to the injected author, validates the answer with a dry run, retries once
 * with the errors, and enforces the session's in-flight and hourly caps. No I/O of its own: the
 * clock, the author and the line matcher are injected.
 * Ported from oh-my-pi 9df0457b31 `job-widgets/registry.ts` (MIT, Copyright Can Boluk et al.).
 */
import {
	createWidgetRedactor,
	type JobWidgetObfuscator,
	type JobWidgetRedactor,
	redactAuthorRequest,
} from "./author-redact.ts";
import type { JobWidgetAuthor, JobWidgetAuthorRequest, JobWidgetBrief } from "./author-types.ts";
import type { LineMatcher } from "./matcher.ts";
import {
	JOB_WIDGET_REQUEST_LIMITS,
	type JobWidgetAuthoringState,
	type JobWidgetRequestJob,
	type JobWidgetRequestLimits,
	type JobWidgetRequestPlan,
	newAuthoringState,
	planRequest,
	REQUEST_WINDOW_MS,
} from "./request-policy.ts";
import { sampleLines } from "./source-stats.ts";
import type { JobWidgetSpec } from "./spec-types.ts";
import { jobWidgetSkip, validateJobWidgetSpec } from "./spec-validate.ts";

export type JobWidgetRequestOutcome =
	| { readonly kind: "installed"; readonly spec: JobWidgetSpec }
	| { readonly kind: "skipped"; readonly reason: string }
	/** Invalid twice (or once with no request left for the retry); without a spec in place the job falls back. */
	| { readonly kind: "rejected"; readonly errors: readonly string[] }
	/**
	 * The author has no model: the call is not counted against the job or the hourly cap, and the
	 * session asks again once {@link JobWidgetRequestLimits.noModelRetryMs} has passed.
	 */
	| { readonly kind: "unavailable" }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "aborted" };

export interface JobWidgetRequestControllerOptions {
	readonly author: JobWidgetAuthor;
	readonly matcher: LineMatcher;
	readonly now?: () => number;
	readonly limits?: Partial<JobWidgetRequestLimits>;
	/** The session's secret obfuscation, run before the built-in redaction. */
	readonly obfuscate?: JobWidgetObfuscator;
}

const ROUNDS = 2;

/** Where a spec's constant totals and targets may come from, besides the samples. */
function statedText(brief: JobWidgetBrief): string {
	return [brief.command, brief.task, brief.intent, brief.watch, brief.stage].filter(Boolean).join("\n");
}

export class JobWidgetRequestController {
	readonly #author: JobWidgetAuthor;
	readonly #matcher: LineMatcher;
	readonly #now: () => number;
	#limits: JobWidgetRequestLimits;
	#redact: JobWidgetRedactor;
	readonly #states = new Map<string, JobWidgetAuthoringState>();
	readonly #aborts = new Map<string, AbortController>();
	/** Start times of author calls in the last {@link REQUEST_WINDOW_MS}, oldest first. */
	readonly #sent: number[] = [];
	#inFlight = 0;
	/** Until when no request starts, after the author last found no model. */
	#noModelUntil = Number.NEGATIVE_INFINITY;

	constructor(options: JobWidgetRequestControllerOptions) {
		this.#author = options.author;
		this.#matcher = options.matcher;
		this.#now = options.now ?? Date.now;
		this.#limits = { ...JOB_WIDGET_REQUEST_LIMITS, ...options.limits };
		this.#redact = createWidgetRedactor(options.obfuscate);
	}

	/** Settings re-read on a re-bind: they apply from the next request on; caps already spent stay spent. */
	configure(options: Pick<JobWidgetRequestControllerOptions, "limits" | "obfuscate">): void {
		this.#limits = { ...JOB_WIDGET_REQUEST_LIMITS, ...options.limits };
		this.#redact = createWidgetRedactor(options.obfuscate);
	}

	get inFlight(): number {
		return this.#inFlight;
	}

	/** Starts the request `job` is due, or returns `undefined` when none is (or a session cap holds it back). */
	maybeRequest(job: JobWidgetRequestJob): Promise<JobWidgetRequestOutcome> | undefined {
		const now = this.#now();
		if (now < this.#noModelUntil) return undefined;
		if (this.#inFlight >= this.#limits.maxInFlight || !this.#windowHasRoom(now)) return undefined;
		let state = this.#states.get(job.id);
		if (!state) {
			state = newAuthoringState();
			this.#states.set(job.id, state);
		}
		const plan = planRequest(job, state, now, this.#limits);
		return plan ? this.#run(job, state, plan) : undefined;
	}

	forget(jobId: string): void {
		this.#aborts.get(jobId)?.abort();
		this.#aborts.delete(jobId);
		this.#states.delete(jobId);
	}

	dispose(): void {
		for (const controller of this.#aborts.values()) controller.abort();
		this.#aborts.clear();
		this.#states.clear();
	}

	#windowHasRoom(now: number): boolean {
		while (this.#sent.length > 0 && now - (this.#sent[0] ?? now) >= REQUEST_WINDOW_MS) this.#sent.shift();
		return this.#sent.length < this.#limits.maxPerHour;
	}

	#canSend(state: JobWidgetAuthoringState): boolean {
		return state.requests < this.#limits.maxRequestsPerJob && this.#windowHasRoom(this.#now());
	}

	async #run(
		job: JobWidgetRequestJob,
		state: JobWidgetAuthoringState,
		plan: JobWidgetRequestPlan,
	): Promise<JobWidgetRequestOutcome> {
		const controller = new AbortController();
		this.#aborts.set(job.id, controller);
		state.inFlight = true;
		this.#inFlight += 1;
		try {
			return await this.#rounds(job, state, plan, controller.signal);
		} catch (error) {
			return controller.signal.aborted ? { kind: "aborted" } : { kind: "failed", error };
		} finally {
			this.#inFlight -= 1;
			state.inFlight = false;
			if (this.#aborts.get(job.id) === controller) this.#aborts.delete(job.id);
		}
	}

	/** One request and at most one retry carrying the validation errors. */
	async #rounds(
		job: JobWidgetRequestJob,
		state: JobWidgetAuthoringState,
		plan: JobWidgetRequestPlan,
		signal: AbortSignal,
	): Promise<JobWidgetRequestOutcome> {
		const raw: JobWidgetAuthorRequest = {
			jobId: job.id,
			brief: job.brief,
			sources: job.runtime.samples(),
			previous: plan.previous,
		};
		const base = redactAuthorRequest(raw, this.#redact);
		const validation = { matcher: this.#matcher, samples: sampleLines(base.sources), brief: statedText(base.brief) };
		let rejected: JobWidgetAuthorRequest["rejected"];
		let errors: readonly string[] = [];
		for (let round = 0; round < ROUNDS && this.#canSend(state); round++) {
			state.requests += 1;
			const sentAt = this.#now();
			this.#sent.push(sentAt);
			const request = rejected ? redactAuthorRequest({ ...raw, rejected }, this.#redact) : base;
			const answer = await this.#author(request, signal);
			if (signal.aborted) return { kind: "aborted" };
			if (answer === undefined) {
				// No call was made: give back the job's request and the hourly slot reserved for it.
				state.requests -= 1;
				const slot = this.#sent.indexOf(sentAt);
				if (slot !== -1) this.#sent.splice(slot, 1);
				this.#noModelUntil = this.#now() + this.#limits.noModelRetryMs;
				return { kind: "unavailable" };
			}
			const skip = jobWidgetSkip(answer);
			if (skip !== undefined) {
				state.skippedWatch = job.brief.watch ?? "";
				return { kind: "skipped", reason: skip };
			}
			const checked = validateJobWidgetSpec(answer, validation);
			if (checked.ok) {
				state.specHadWatch = Boolean(job.brief.watch);
				return { kind: "installed", spec: checked.spec };
			}
			errors = checked.errors;
			rejected = { answer: JSON.stringify(answer), errors };
		}
		if (!job.runtime.spec) state.stopped = true;
		return { kind: "rejected", errors };
	}
}
