import { type ExtensionHandlerBudget, type ExtensionHandlerStall, runBudgetedHandler } from "./handler-budget.ts";
import type { SessionStopOwnerReport, SessionStopReport, SessionStopResult } from "./types.ts";

export interface SessionStopHandlerCall {
	readonly extensionPath: string;
	readonly call: (signal: AbortSignal) => unknown;
}

function isStopResult(value: unknown): value is SessionStopResult {
	if (typeof value !== "object" || value === null) return false;
	const { stopped, failed } = value as Partial<SessionStopResult>;
	return Array.isArray(stopped) && Array.isArray(failed);
}

function ownerFailure(extensionPath: string, reason: string): SessionStopOwnerReport {
	return { extensionPath, stopped: [], failed: [{ kind: "extension", id: extensionPath, reason }] };
}

function warnStall(budget: ExtensionHandlerBudget, stall: ExtensionHandlerStall): void {
	if (stall.stage !== "warn") return;
	const capNote = budget.timeoutMs > 0 ? ` (hard cap ${budget.timeoutMs}ms)` : "";
	console.warn(
		`Extension ${stall.extensionPath} is still running its session_stop handler after ${stall.elapsedMs}ms${capNote}.`,
	);
}

/**
 * Runs every `session_stop` handler in order, each under `budget`, and gathers their reports. A stop must never hang on
 * one owner (oh-my-openagent#14354): a handler that throws, answers something that is not a report, or is still running
 * at the hard cap becomes a `failed` entry naming its extension, and the stop moves on to the next owner. A handler that
 * answers undefined owns nothing a stop ends and is left out of the report.
 */
export async function runSessionStopHandlers(
	calls: readonly SessionStopHandlerCall[],
	budget: ExtensionHandlerBudget,
): Promise<SessionStopReport> {
	const owners: SessionStopOwnerReport[] = [];
	for (const { extensionPath, call } of calls) {
		const outcome = await runBudgetedHandler<unknown>({
			extensionPath,
			event: "session_stop",
			budget,
			run: call,
			onStall: (stall) => warnStall(budget, stall),
		});
		switch (outcome.kind) {
			case "settled":
				if (outcome.value === undefined) break;
				owners.push(
					isStopResult(outcome.value)
						? { extensionPath, stopped: [...outcome.value.stopped], failed: [...outcome.value.failed] }
						: ownerFailure(
								extensionPath,
								"the session_stop handler answered something that is not a stop report",
							),
				);
				break;
			case "failed":
				owners.push(
					ownerFailure(
						extensionPath,
						outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
					),
				);
				break;
			case "timed_out":
				owners.push(
					ownerFailure(extensionPath, `the session_stop handler did not finish within ${budget.timeoutMs}ms`),
				);
				break;
			case "released":
			case "yielded":
				owners.push(
					ownerFailure(extensionPath, "the host stopped waiting before the session_stop handler finished"),
				);
				break;
		}
	}
	return { owners };
}
