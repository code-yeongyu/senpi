/**
 * The author port: who writes a job's widget spec. senpi defines the port; a host injects an
 * implementation (a model-backed one from `model-author.ts`, or its own route to a cheap model).
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { JobWidgetSourceSample } from "./source-stats.ts";
import type { JobWidgetSpec } from "./spec-types.ts";

export type JobWidgetJobKind = "bash" | "task";

/** What the job is, in the words of whoever started it. */
export interface JobWidgetBrief {
	readonly kind: JobWidgetJobKind;
	readonly command?: string;
	readonly task?: string;
	readonly intent?: string;
	/** What a task's subagent says to watch; a task job is authored only once it has one. */
	readonly watch?: string;
	readonly stage?: string;
}

/** What the author is asked to write a spec for. Every text in it is already redacted. */
export interface JobWidgetAuthorRequest {
	readonly jobId: string;
	readonly brief: JobWidgetBrief;
	/** Per source: first and last lines, most active first. */
	readonly sources: readonly JobWidgetSourceSample[];
	/** Re-authoring: the spec in place and why it is being replaced. */
	readonly previous?: { readonly spec: JobWidgetSpec; readonly reason: string };
	/** Retry: the rejected answer and what was wrong with it. */
	readonly rejected?: { readonly answer: string; readonly errors: readonly string[] };
}

/**
 * Writes one candidate spec (unvalidated: the request controller validates and retries once).
 * Resolves `undefined` when no model can write specs, which stops further requests for the job.
 */
export type JobWidgetAuthor = (request: JobWidgetAuthorRequest, signal: AbortSignal) => Promise<unknown>;
