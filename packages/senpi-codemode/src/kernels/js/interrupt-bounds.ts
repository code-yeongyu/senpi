import type { WorkerLike } from "./inline-worker.ts";
import type { PendingJavaScriptRun } from "./run-queue.ts";

/** How long the worker gets to acknowledge `interrupt`; silence means its event loop is blocked in synchronous code. */
export const INTERRUPT_ACK_MS = 500;
/** How long an acknowledged cell gets to settle before the VM is replaced. */
export const JS_INTERRUPT_GRACE_MS = 2_000;
/** How long `worker.terminate()` may take before the worker is abandoned as blocked in a synchronous call. */
export const WORKER_TERMINATE_DEADLINE_MS = 3_000;

export type CooperativeSettlement = "settled" | "unresponsive";
export type WorkerRetirement = "terminated" | "abandoned";

export interface CooperativeSettlementBounds {
	readonly ackMs: number;
	readonly graceMs: number;
}

const DEFAULT_SETTLEMENT_BOUNDS: CooperativeSettlementBounds = {
	ackMs: INTERRUPT_ACK_MS,
	graceMs: JS_INTERRUPT_GRACE_MS,
};

export async function awaitCooperativeSettlement(
	run: PendingJavaScriptRun,
	bounds = DEFAULT_SETTLEMENT_BOUNDS,
): Promise<CooperativeSettlement> {
	if (run.settled) return "settled";
	const settled = run.settlement.then((): "settled" => "settled");
	const acked = run.interruptAck?.promise.then((): "acked" => "acked") ?? Promise.resolve<"acked">("acked");
	const first = await raceDeadline(Promise.race([settled, acked]), bounds.ackMs, "unresponsive");
	if (first !== "acked") return first;
	return await raceDeadline(settled, bounds.graceMs, "unresponsive");
}

export async function retireWorker(
	worker: WorkerLike,
	deadlineMs = WORKER_TERMINATE_DEADLINE_MS,
): Promise<WorkerRetirement> {
	const termination = worker.terminate().then((): WorkerRetirement => "terminated");
	const outcome = await raceDeadline(termination, deadlineMs, "abandoned");
	if (outcome === "abandoned") void termination.then(undefined, ignoreLateTerminationFailure);
	return outcome;
}

export function abandonedWorkerNote(deadlineMs = WORKER_TERMINATE_DEADLINE_MS): string {
	return `JavaScript worker did not stop within ${deadlineMs}ms: a synchronous call (for example Bun.spawnSync or child_process.spawnSync) is blocking it. A fresh worker replaced it; the blocked call keeps running until it returns.\n`;
}

async function raceDeadline<T extends string, Fallback extends string>(
	operation: Promise<T>,
	deadlineMs: number,
	fallback: Fallback,
): Promise<T | Fallback> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<Fallback>((resolve) => {
		timer = setTimeout(() => resolve(fallback), deadlineMs);
	});
	try {
		return await Promise.race([operation, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function ignoreLateTerminationFailure(): void {}
