/**
 * Sends a session's `job_widget_state` at most once per {@link PUBLISH_INTERVAL_MS} and only when
 * what a client draws changed: `updatedAtMs` moves with every output line, so it does not count.
 * A burst inside the interval collapses into one trailing send of the newest state. A change that
 * is only a `fallback` view's latest output line or line count (a noisy job with no widget, such as
 * a dev server) waits for {@link FALLBACK_INTERVAL_MS} instead; any other change goes out on the
 * normal beat. Every view is redacted here, before it is compared or sent, so nothing a client
 * receives carries a secret.
 */
import type { JobWidgetRedact } from "./author-redact.ts";
import { redactJobWidgetState } from "./view-redact.ts";
import type { JobWidgetEntry, JobWidgetState } from "./view-types.ts";

export const PUBLISH_INTERVAL_MS = 1000;
export const FALLBACK_INTERVAL_MS = 5000;

function displayKey(state: JobWidgetState): string {
	return JSON.stringify(state.jobs.map(({ updatedAtMs: _updatedAtMs, ...shown }) => shown));
}

/** The display key without what a fallback view's output moves (its stage line and line count). */
function coarseKey(state: JobWidgetState): string {
	return displayKey({
		...state,
		jobs: state.jobs.map((job): JobWidgetEntry => {
			if (job.state !== "fallback" || job.view === undefined) return job;
			const { stage: _stage, lines: _lines, ...view } = job.view;
			return { ...job, view: { ...view, blocks: view.blocks } };
		}),
	});
}

const EMPTY_KEY = "[]";

export class JobWidgetStatePublisher {
	readonly #send: (state: JobWidgetState) => void;
	readonly #redact: JobWidgetRedact;
	#sentKey = EMPTY_KEY;
	#sentCoarseKey = EMPTY_KEY;
	#sentAt: number | undefined;
	#latest: JobWidgetState | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#timerAt: number | undefined;
	#disposed = false;

	constructor(send: (state: JobWidgetState) => void, redact: JobWidgetRedact) {
		this.#send = send;
		this.#redact = redact;
	}

	/** `state` as it may leave the engine: every view string redacted. */
	redacted(state: JobWidgetState): JobWidgetState {
		return redactJobWidgetState(state, this.#redact);
	}

	/** The newest state; sent now, at the end of the current interval, or not at all when unchanged. */
	offer(state: JobWidgetState): void {
		if (this.#disposed) return;
		this.#latest = state;
		this.#schedule();
	}

	/** Forgets what was sent, so the next offer goes out even if unchanged (a new listener needs it). */
	reset(): void {
		this.#sentKey = "";
		this.#sentCoarseKey = "";
	}

	dispose(): void {
		this.#disposed = true;
		this.#clearTimer();
	}

	#clearTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#timerAt = undefined;
	}

	/** Sends the newest state now, or arms (or pulls in) the one timer for when it may go. */
	#schedule(): void {
		const state = this.#latest;
		if (!state) return;
		const redacted = this.redacted(state);
		const key = displayKey(redacted);
		if (key === this.#sentKey) {
			this.#clearTimer();
			return;
		}
		const sentAt = this.#sentAt ?? Number.NEGATIVE_INFINITY;
		const interval = coarseKey(redacted) === this.#sentCoarseKey ? FALLBACK_INTERVAL_MS : PUBLISH_INTERVAL_MS;
		const at = sentAt + interval;
		const now = Date.now();
		if (at <= now) {
			this.#clearTimer();
			this.#sentKey = key;
			this.#sentCoarseKey = coarseKey(redacted);
			this.#sentAt = now;
			this.#send(redacted);
			return;
		}
		if (this.#timerAt !== undefined && this.#timerAt <= at) return;
		this.#clearTimer();
		this.#timerAt = at;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#timerAt = undefined;
			if (!this.#disposed) this.#schedule();
		}, at - now);
		this.#timer.unref?.();
	}
}
