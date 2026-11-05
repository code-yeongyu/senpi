import type { BatchCoordinator } from "./coordinator.ts";
import type { BatchPlan, BatchResult, CallOutcome } from "./coordinator-types.ts";

/** `toolExecution: "sequential"` on the coordinator (design 5.6.1 scheduler modes, S11). */
export interface SequentialCoordinator {
	/**
	 * Runs each call as its own one-call batch, in source order: a call is prepared and run to its final outcome before
	 * the next is prepared, as today's sequential scheduler interleaves them. The one-call batches are durable, so running
	 * the same plan again after a crash returns the finished calls' stored outcomes and resumes the one in flight. A
	 * call whose batch ABORTs (its preparation was stopped) ends the run: the calls after it are never prepared and are
	 * reported `not_run`.
	 */
	run(plan: BatchPlan): Promise<BatchResult>;
}

/** The durable batch id of call `index` of `batchId`; stable across runs, so a resumed run finds it. */
const sequentialBatchId = (batchId: string, index: number): string => `${batchId}#${index}`;

/**
 * The cause the calls after an ABORTed call inherit, as one batch gives its unrun calls the batch's own cause: after an
 * interrupted preparation they replay with today's placeholder (X12), after a stop as an aborted batch. A one-call batch
 * ABORTs only on its call's preparation, so an aborting call that is not `not_run` settled at preparation, and one batch
 * fails that closed as an interrupted preparation whatever the stored reason (`blocked` included, `abortCause`).
 */
function inheritedCause(aborting: CallOutcome | undefined): "batch_abort" | "interrupted_preparation" {
	if (aborting === undefined) return "batch_abort";
	return aborting.kind === "not_run" ? aborting.cause : "interrupted_preparation";
}

export function createSequentialCoordinator(coordinator: BatchCoordinator): SequentialCoordinator {
	return {
		run: async (plan) => {
			const outcomes: CallOutcome[] = [];
			for (const [index, call] of plan.calls.entries()) {
				const single = await coordinator.run({
					...plan,
					batchId: sequentialBatchId(plan.batchId, index),
					calls: [call],
				});
				outcomes.push(...single.outcomes);
				if (single.decision === "ABORT") {
					const notRun: CallOutcome = { kind: "not_run", cause: inheritedCause(single.outcomes[0]) };
					return { decision: "ABORT", outcomes: [...outcomes, ...plan.calls.slice(index + 1).map(() => notRun)] };
				}
			}
			return { decision: "RELEASE", outcomes };
		},
	};
}
