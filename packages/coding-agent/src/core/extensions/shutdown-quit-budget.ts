import type { ExtensionHandlerBudget } from "./handler-budget.ts";

export interface SessionShutdownBudget {
	readonly handler: ExtensionHandlerBudget;
	readonly quitMs: number;
}

export interface QuitHandlerBudget {
	readonly budget: ExtensionHandlerBudget;
	readonly endsAtQuitDeadline: boolean;
}

/**
 * One deadline shared by every `session_shutdown` handler of a quit that ends in process exit (senpi#3711),
 * counted from the moment the shutdown emission is armed. Each handler keeps its own cap
 * and is still started in order; the host only stops waiting once the deadline passes. A handler that starts after
 * the deadline gets 1 ms, so synchronous cleanup still completes and asynchronous work is left running.
 */
export class QuitDeadline {
	private readonly deadline: number;
	private readonly now: () => number;

	constructor(totalMs: number, now: () => number, startedAt: number = now()) {
		this.now = now;
		this.deadline = startedAt + totalMs;
	}

	budgetFor(base: ExtensionHandlerBudget): QuitHandlerBudget {
		const remaining = Math.max(1, this.deadline - this.now());
		if (base.timeoutMs > 0 && base.timeoutMs <= remaining) return { budget: base, endsAtQuitDeadline: false };
		const warnMs = base.warnMs < remaining ? base.warnMs : 0;
		return { budget: { warnMs, timeoutMs: remaining }, endsAtQuitDeadline: true };
	}
}
