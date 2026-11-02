import { type ExtensionHandlerBudget, type ExtensionHandlerStall, runBudgetedHandler } from "./handler-budget.ts";
import type { SessionMoveExportEvent, SessionMoveImportEvent } from "./types.ts";

/** A move event as the host emits it; each handler receives it with the budget's own `signal`. */
export type SessionMoveEmission = Omit<SessionMoveExportEvent, "signal"> | Omit<SessionMoveImportEvent, "signal">;

/** A `session_move_export` / `session_move_import` handler that threw or was still running at the handler budget. */
export interface SessionMoveFailure {
	readonly extensionPath: string;
	readonly error: string;
	readonly stack?: string;
}

export interface SessionMoveHandlerCall {
	readonly extensionPath: string;
	readonly call: (signal: AbortSignal) => unknown;
}

function warnStall(event: string, budget: ExtensionHandlerBudget, stall: ExtensionHandlerStall): void {
	if (stall.stage !== "warn") return;
	const capNote = budget.timeoutMs > 0 ? ` (hard cap ${budget.timeoutMs}ms)` : "";
	console.warn(
		`Extension ${stall.extensionPath} is still running its ${event} handler after ${stall.elapsedMs}ms${capNote}.`,
	);
}

/**
 * Runs every move handler, in order, each under `budget` (the `session_shutdown` handler budget, warned at `warnMs`
 * and aborted through its signal at `timeoutMs`), and returns every failure. Unlike the ordinary emit, a failure is
 * the caller's decision: a move's state would otherwise be lost. A handler past the cap keeps running detached.
 */
export async function runSessionMoveHandlers(
	event: string,
	calls: readonly SessionMoveHandlerCall[],
	budget: ExtensionHandlerBudget,
): Promise<readonly SessionMoveFailure[]> {
	const failures: SessionMoveFailure[] = [];
	for (const { extensionPath, call } of calls) {
		const outcome = await runBudgetedHandler({
			extensionPath,
			event,
			budget,
			run: call,
			onStall: (stall) => warnStall(event, budget, stall),
		});
		switch (outcome.kind) {
			case "settled":
				break;
			case "failed": {
				const { error } = outcome;
				failures.push({
					extensionPath,
					error: error instanceof Error ? error.message : String(error),
					...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
				});
				break;
			}
			case "timed_out":
				failures.push({ extensionPath, error: `handler timed out after ${budget.timeoutMs}ms` });
				break;
			case "released":
				failures.push({ extensionPath, error: "handler released before it finished" });
				break;
		}
	}
	return failures;
}
