/**
 * One job in a session's widget registry: its text sources, its derivation runtime (replaced by a
 * fresh one whenever a spec is installed), and where its spec request stands. A running bash job is
 * in the session's `job_widget_state` from the start: until a spec is installed (before its first
 * request, after the author skipped it, while a session cap holds the request back, or after the
 * author failed) it shows the plain `fallback` row with how long it has been running, so a silent
 * job never looks like nothing is running. A task job joins once its first spec request starts. A
 * finished job is listed as before: a never-asked one is absent, a skipped one stays `skipped`.
 */
import type { JobWidgetRedactor } from "./author-redact.ts";
import type { JobWidgetBrief, JobWidgetJobKind } from "./author-types.ts";
import type { LineMatcher } from "./matcher.ts";
import type { JobWidgetRequestOutcome } from "./request-controller.ts";
import type { JobWidgetRequestJob } from "./request-policy.ts";
import { JobWidgetRuntime } from "./runtime.ts";
import type { JobTextSource } from "./source-types.ts";
import type { JobWidgetEntry } from "./view-types.ts";

/** What a host says about a job when it registers it; the kind lives beside the brief, not in it. */
export type JobWidgetBriefText = Omit<JobWidgetBrief, "kind">;

export interface JobWidgetJobInput {
	/** `bash_id` or `st_` task id; unique within the session. */
	readonly id: string;
	readonly kind: JobWidgetJobKind;
	readonly sources: readonly JobTextSource[];
	readonly brief: JobWidgetBriefText;
	/** When the job started; its age gates the first spec request. Defaults to now. */
	readonly startedAtMs?: number;
}

export class JobWidgetJob implements JobWidgetRequestJob {
	readonly id: string;
	readonly kind: JobWidgetJobKind;
	readonly startTime: number;
	readonly sources: readonly JobTextSource[];
	brief: JobWidgetBrief;
	runtime: JobWidgetRuntime;
	settled = false;
	readonly #matcher: LineMatcher;
	readonly #redact: JobWidgetRedactor;
	#asked = false;
	#authoring = false;
	#skippedAtMs: number | undefined;

	constructor(input: JobWidgetJobInput, matcher: LineMatcher, redact: JobWidgetRedactor) {
		this.id = input.id;
		this.kind = input.kind;
		this.startTime = input.startedAtMs ?? Date.now();
		this.sources = input.sources;
		this.brief = { ...input.brief, kind: input.kind };
		this.#matcher = matcher;
		this.#redact = redact;
		this.runtime = this.#newRuntime(undefined);
	}

	#newRuntime(spec: JobWidgetRuntime["spec"]): JobWidgetRuntime {
		return new JobWidgetRuntime({
			spec,
			matcher: this.#matcher,
			startTime: this.startTime,
			redactSource: () => this.#redact.source(),
		});
	}

	ingest(): void {
		this.runtime.ingest(this.sources, this.settled);
	}

	requestStarted(): void {
		this.#asked = true;
		this.#authoring = true;
	}

	requestSettled(outcome: JobWidgetRequestOutcome): void {
		this.#authoring = false;
		if (outcome.kind === "installed") {
			this.runtime = this.#newRuntime(outcome.spec);
			this.ingest();
		} else if (outcome.kind === "skipped" && !this.runtime.spec) {
			this.#skippedAtMs = Date.now();
		}
	}

	entry(): JobWidgetEntry | undefined {
		// A running bash job always has a row; a task job's row waits for its subagent's watch hint.
		const running = this.kind === "bash" && !this.settled;
		if (this.#skippedAtMs !== undefined && !running) {
			return { id: this.id, kind: this.kind, state: "skipped", updatedAtMs: this.#skippedAtMs };
		}
		if (!this.#asked && !running) return undefined;
		const brief = this.brief;
		const derived = this.runtime.derive({
			label: this.#redact.text(brief.intent ?? brief.task ?? brief.command ?? this.id),
			...(brief.stage === undefined ? {} : { stage: this.#redact.text(brief.stage) }),
			lineStage: this.kind === "bash",
			authoring: this.#authoring,
			settled: this.settled,
		});
		return {
			id: this.id,
			kind: this.kind,
			// A finished bash job whose spec request failed has no spec to freeze; it is still done.
			state: this.kind === "bash" && this.settled && derived.state === "fallback" ? "done" : derived.state,
			view: derived.view,
			updatedAtMs: derived.updatedAtMs,
			startedAtMs: this.startTime,
		};
	}
}
