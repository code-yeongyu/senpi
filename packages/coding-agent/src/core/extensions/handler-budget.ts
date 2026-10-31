/**
 * Host budget for extension event handlers (senpi#3650). Past `warnMs` the host reports a handler as stalled; at
 * `timeoutMs`, or when the turn deadline releases the turn it belongs to, the host stops waiting on it and moves on
 * (the handler keeps running detached). A value of 0 disables that limit.
 */
export interface ExtensionHandlerBudget {
	readonly warnMs: number;
	readonly timeoutMs: number;
}

export type ExtensionHandlerStallStage = "warn" | "timeout" | "released" | "late_failure";

export interface ExtensionHandlerStall {
	readonly extensionPath: string;
	readonly event: string;
	readonly stage: ExtensionHandlerStallStage;
	readonly elapsedMs: number;
	readonly timeoutMs: number;
	readonly error?: string;
}

/**
 * Why the host stopped waiting on a handler: its hard cap ran out, the turn was stopped (deadline or Esc), or a person's
 * next input moved on from a settled run whose notification-only handler was still running (omo#11419).
 */
export type HandlerStopVerdict = "timed_out" | "released" | "yielded";

export type BudgetedHandlerOutcome<T> =
	| { readonly kind: "settled"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "timed_out" }
	| { readonly kind: "released" }
	| { readonly kind: "yielded" };

/** Waits on running handlers, tagged with the turn that owns them so a deadline releases only its own turn's waits. */
export class HeldHandlerWaits {
	private readonly releases = new Map<(verdict: HandlerStopVerdict) => void, number>();

	hold(scope: number, release: (verdict: HandlerStopVerdict) => void): () => void {
		this.releases.set(release, scope);
		return () => this.releases.delete(release);
	}

	release(scope: number, verdict: HandlerStopVerdict = "released"): number {
		const owned = [...this.releases].filter(([, owner]) => owner === scope).map(([release]) => release);
		for (const release of owned) {
			this.releases.delete(release);
			release(verdict);
		}
		return owned.length;
	}
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface HandlerWatch {
	readonly startedAt: number;
	disarm(): void;
}

interface WatchOptions {
	readonly extensionPath: string;
	readonly event: string;
	readonly budget: ExtensionHandlerBudget;
	readonly onStall?: (stall: ExtensionHandlerStall) => void;
	readonly now: () => number;
}

function watchHandler(
	options: WatchOptions,
	stop: (verdict: HandlerStopVerdict) => void,
	held?: HeldHandlerSlot,
): HandlerWatch {
	const { budget, extensionPath, event, now } = options;
	const startedAt = now();
	const stall = (stage: ExtensionHandlerStallStage): void =>
		options.onStall?.({ extensionPath, event, stage, elapsedMs: now() - startedAt, timeoutMs: budget.timeoutMs });
	let stopped = false;
	const end = (verdict: HandlerStopVerdict): void => {
		if (stopped) return;
		stopped = true;
		disarm();
		stall(verdict === "timed_out" ? "timeout" : "released");
		stop(verdict);
	};
	const warnTimer = budget.warnMs > 0 ? setTimeout(() => stall("warn"), budget.warnMs) : undefined;
	const capTimer = budget.timeoutMs > 0 ? setTimeout(() => end("timed_out"), budget.timeoutMs) : undefined;
	const unhold = held?.waits.hold(held.scope(), (verdict) => end(verdict));
	function disarm(): void {
		clearTimeout(warnTimer);
		clearTimeout(capTimer);
		unhold?.();
	}
	return {
		startedAt,
		disarm: () => {
			stopped = true;
			disarm();
		},
	};
}

export interface HeldHandlerSlot {
	readonly waits: HeldHandlerWaits;
	readonly scope: () => number;
}

export interface BudgetedHandlerRun<T> {
	readonly extensionPath: string;
	readonly event: string;
	readonly budget: ExtensionHandlerBudget;
	readonly run: (signal: AbortSignal) => Promise<T> | T;
	readonly onStall?: (stall: ExtensionHandlerStall) => void;
	readonly now?: () => number;
}

/** One handler under the budget, with an abort signal it can observe (the `session_shutdown` path). */
export async function runBudgetedHandler<T>(options: BudgetedHandlerRun<T>): Promise<BudgetedHandlerOutcome<T>> {
	const controller = new AbortController();
	// The handler outcome is captured before any race, so a late rejection after a timeout is already handled.
	let started: Promise<T>;
	try {
		started = Promise.resolve(options.run(controller.signal));
	} catch (error) {
		started = Promise.reject(error);
	}
	const settled = started.then(
		(value): BudgetedHandlerOutcome<T> => ({ kind: "settled", value }),
		(error: unknown): BudgetedHandlerOutcome<T> => ({ kind: "failed", error }),
	);
	if (options.budget.warnMs <= 0 && options.budget.timeoutMs <= 0) return settled;
	let watch: HandlerWatch | undefined;
	const outcome = await new Promise<BudgetedHandlerOutcome<T>>((resolve) => {
		watch = watchHandler({ ...options, now: options.now ?? Date.now }, (verdict) => {
			controller.abort(new Error(`${options.event} handler ${verdict === "timed_out" ? "timed out" : "released"}`));
			resolve({ kind: verdict });
		});
		void settled.then(resolve);
	});
	watch?.disarm();
	return outcome;
}

export type HandlerCallOutcome =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: unknown };

export interface BudgetedSequence<R> {
	readonly event: string;
	readonly length: number;
	extensionPath(index: number): string;
	/** Calls handler `index`; returns its result or promise, unwrapped by the sequence with a plain `await`. */
	start(index: number): unknown;
	/** Applies a handler's outcome; may return a promise only when it has async host work of its own. */
	settle(index: number, outcome: HandlerCallOutcome): void | Promise<void>;
	skip(index: number, verdict: HandlerStopVerdict, budget: ExtensionHandlerBudget): void;
	/** Ends the walk early (for example a retired runner); the sequence then resolves with `finish()`. */
	halted?(): boolean;
	finish(): R;
}

export interface SequenceOptions {
	readonly budget: ExtensionHandlerBudget;
	readonly held?: HeldHandlerSlot;
	readonly onStall?: (stall: ExtensionHandlerStall) => void;
	readonly now?: () => number;
}

/**
 * Walks an emission's handlers under the budget. A handler that settles in time is awaited exactly as a direct
 * `await handler()` would be, so a timely emission keeps its microtask timing. A handler past its cap, or released
 * by the turn deadline, is skipped: the walk resumes at the next handler in a new run that settles the emission,
 * and the abandoned run stops when its handler ever returns. A failure after the host stopped waiting is reported.
 */
export function runBudgetedSequence<R>(sequence: BudgetedSequence<R>, options: SequenceOptions): Promise<R> {
	const now = options.now ?? Date.now;
	return new Promise<R>((resolve, reject) => {
		let generation = 0;
		const run = async (from: number, owner: number): Promise<void> => {
			for (let index = from; index < sequence.length; index += 1) {
				if (owner !== generation) return;
				if (sequence.halted?.()) break;
				const extensionPath = sequence.extensionPath(index);
				const watchOptions = {
					extensionPath,
					event: sequence.event,
					budget: options.budget,
					onStall: options.onStall,
					now,
				};
				const watch = watchHandler(
					watchOptions,
					(verdict) => {
						if (owner !== generation) return;
						generation += 1;
						sequence.skip(index, verdict, options.budget);
						run(index + 1, generation).catch(reject);
					},
					options.held,
				);
				let outcome: HandlerCallOutcome;
				try {
					outcome = { ok: true, value: await sequence.start(index) };
				} catch (error) {
					outcome = { ok: false, error };
				}
				watch.disarm();
				if (owner !== generation) {
					if (!outcome.ok) {
						options.onStall?.({
							extensionPath,
							event: sequence.event,
							stage: "late_failure",
							elapsedMs: now() - watch.startedAt,
							timeoutMs: options.budget.timeoutMs,
							error: describeError(outcome.error),
						});
					}
					return;
				}
				const settling = sequence.settle(index, outcome);
				if (settling !== undefined) await settling;
			}
			if (owner === generation) resolve(sequence.finish());
		};
		run(0, 0).catch(reject);
	});
}
