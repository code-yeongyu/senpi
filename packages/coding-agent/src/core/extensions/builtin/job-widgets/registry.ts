/**
 * One session's job widgets: the jobs hosts registered, the request controller their spec requests
 * share, and the refresh loop. New output schedules a refresh at most every
 * {@link INGEST_MIN_INTERVAL_MS}; a 1 s unref'd ticker covers time-based work (a job turning old
 * enough to author) and runs only while some job is still open. Every refresh offers the session's
 * state to the publisher, which sends it only when it changed and at most once a second.
 */
import { createWidgetRedactor, type JobWidgetObfuscator, type JobWidgetRedactor } from "./author-redact.ts";
import type { JobWidgetAuthor } from "./author-types.ts";
import type { LineMatcher } from "./matcher.ts";
import { defaultLineMatcher } from "./re2-matcher.ts";
import { JobWidgetJob, type JobWidgetBriefText, type JobWidgetJobInput } from "./registry-job.ts";
import { JobWidgetRequestController } from "./request-controller.ts";
import type { JobWidgetRequestLimits } from "./request-policy.ts";
import { JobWidgetStatePublisher } from "./state-publisher.ts";
import type { JobWidgetEntry, JobWidgetState } from "./view-types.ts";

const INGEST_MIN_INTERVAL_MS = 250;
const REFRESH_INTERVAL_MS = 1000;

/** A host's hold on one registered job. Every call is a no-op once the job is forgotten. */
export interface JobWidgetSourceHandle {
	/** New text arrived on one of the job's sources. */
	notify(): void;
	/** The job's own words changed (a task's `watch` hint or `stage`). */
	update(brief: JobWidgetBriefText): void;
	/** The job finished: its widget freezes as `done`. */
	settle(): void;
	/** The job is gone (evicted, or no longer a widget candidate): its entry leaves the state. */
	dispose(): void;
}

export interface JobWidgetRegistryOptions {
	readonly sessionId: string;
	readonly author: JobWidgetAuthor;
	readonly publish: (state: JobWidgetState) => void;
	readonly limits?: Partial<JobWidgetRequestLimits>;
	readonly obfuscate?: JobWidgetObfuscator;
	readonly matcher?: LineMatcher;
}

const INERT_HANDLE: JobWidgetSourceHandle = {
	notify: () => {},
	update: () => {},
	settle: () => {},
	dispose: () => {},
};

export class JobWidgetRegistry {
	readonly sessionId: string;
	readonly #matcher: LineMatcher;
	readonly #redact: JobWidgetRedactor;
	readonly #controller: JobWidgetRequestController;
	readonly #publisher: JobWidgetStatePublisher;
	readonly #jobs = new Map<string, JobWidgetJob>();
	#ticker: ReturnType<typeof setInterval> | undefined;
	#ingestTimer: ReturnType<typeof setTimeout> | undefined;
	#lastRefreshAt = Number.NEGATIVE_INFINITY;
	#disposed = false;

	constructor(options: JobWidgetRegistryOptions) {
		this.sessionId = options.sessionId;
		this.#matcher = options.matcher ?? defaultLineMatcher;
		this.#redact = createWidgetRedactor(options.obfuscate);
		this.#controller = new JobWidgetRequestController({
			author: options.author,
			matcher: this.#matcher,
			...(options.limits === undefined ? {} : { limits: options.limits }),
			...(options.obfuscate === undefined ? {} : { obfuscate: options.obfuscate }),
		});
		this.#publisher = new JobWidgetStatePublisher(options.publish, this.#redact.text);
	}

	add(input: JobWidgetJobInput): JobWidgetSourceHandle {
		if (this.#disposed) return INERT_HANDLE;
		const previous = this.#jobs.get(input.id);
		if (previous) this.#forget(previous);
		const job = new JobWidgetJob(input, this.#matcher, this.#redact);
		this.#jobs.set(job.id, job);
		this.#refresh(job);
		this.#ensureTicker();
		const live = (): boolean => this.#jobs.get(job.id) === job;
		return {
			notify: () => {
				if (live() && !job.settled) this.#scheduleRefresh();
			},
			update: (brief) => {
				if (!live()) return;
				job.brief = { ...brief, kind: job.kind };
				this.#scheduleRefresh();
			},
			settle: () => {
				if (live()) this.#settle(job);
			},
			dispose: () => {
				if (live()) this.#forget(job);
			},
		};
	}

	/** The session's state as clients receive it: every view redacted. */
	state(): JobWidgetState {
		return this.#publisher.redacted(this.snapshot());
	}

	snapshot(): JobWidgetState {
		const jobs: JobWidgetEntry[] = [];
		for (const job of this.#jobs.values()) {
			const entry = job.entry();
			if (entry) jobs.push(entry);
		}
		return { v: 1, sessionId: this.sessionId, jobs };
	}

	/** Sends the current state on the next offer even if unchanged, for a listener that just bound. */
	republish(): void {
		this.#publisher.reset();
		this.#publish();
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopTicker();
		clearTimeout(this.#ingestTimer);
		this.#ingestTimer = undefined;
		this.#controller.dispose();
		this.#publisher.dispose();
		this.#jobs.clear();
	}

	#scheduleRefresh(): void {
		if (this.#disposed || this.#ingestTimer !== undefined) return;
		const wait = Math.max(0, this.#lastRefreshAt + INGEST_MIN_INTERVAL_MS - Date.now());
		this.#ingestTimer = setTimeout(() => {
			this.#ingestTimer = undefined;
			this.#refreshAll();
		}, wait);
		this.#ingestTimer.unref?.();
	}

	#refreshAll(): void {
		if (this.#disposed) return;
		this.#lastRefreshAt = Date.now();
		for (const job of this.#jobs.values()) if (!job.settled) this.#refresh(job);
		this.#publish();
	}

	#refresh(job: JobWidgetJob): void {
		job.ingest();
		if (job.settled) return;
		const pending = this.#controller.maybeRequest(job);
		if (!pending) return;
		job.requestStarted();
		void pending.then((outcome) => {
			if (this.#disposed || this.#jobs.get(job.id) !== job) return;
			job.requestSettled(outcome);
			this.#publish();
		});
	}

	#settle(job: JobWidgetJob): void {
		job.settled = true;
		job.ingest();
		this.#publish();
		this.#stopTickerWhenIdle();
	}

	#forget(job: JobWidgetJob): void {
		this.#jobs.delete(job.id);
		this.#controller.forget(job.id);
		this.#publish();
		this.#stopTickerWhenIdle();
	}

	#publish(): void {
		if (!this.#disposed) this.#publisher.offer(this.snapshot());
	}

	#ensureTicker(): void {
		if (this.#ticker !== undefined) return;
		this.#ticker = setInterval(() => this.#refreshAll(), REFRESH_INTERVAL_MS);
		this.#ticker.unref?.();
	}

	#stopTickerWhenIdle(): void {
		for (const job of this.#jobs.values()) if (!job.settled) return;
		this.#stopTicker();
	}

	#stopTicker(): void {
		clearInterval(this.#ticker);
		this.#ticker = undefined;
	}
}
