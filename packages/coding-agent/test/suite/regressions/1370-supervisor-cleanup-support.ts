import type * as childProcess from "node:child_process";
import { terminateProcessTrees } from "../../../../senpi-codemode/src/kernels/js/process-tree-host.ts";

// senpi#4703: a rejected exit-wait with a live pid must fail by name; only a spawn that never produced a
// pid has nothing to stop.

export const SUPERVISOR_EXIT_DEADLINE_MS = 5_000;
export const STDERR_DRAIN_MS = 2_000;

export type WaitOutcome =
	| { readonly kind: "settled" }
	| { readonly kind: "late" }
	| { readonly kind: "failed"; readonly cause: unknown };

export async function settleWithin(ms: number, work: Promise<unknown>): Promise<WaitOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then(
				(): WaitOutcome => ({ kind: "settled" }),
				(cause: unknown): WaitOutcome => ({ kind: "failed", cause }),
			),
			new Promise<WaitOutcome>((resolveLate) => {
				timer = setTimeout(() => resolveLate({ kind: "late" }), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function earlyExitError(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderrClosed: Promise<unknown>,
	output: () => string,
): Promise<Error> {
	const drain = await settleWithin(STDERR_DRAIN_MS, stderrClosed);
	const message = `supervisor exited (code ${code}, signal ${signal}) before readiness:\n${output()}`;
	return drain.kind === "failed" ? new Error(message, { cause: drain.cause }) : new Error(message);
}

function signalGroup(group: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-group, signal);
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
	}
}

function outcomeAllowsReturn(outcome: WaitOutcome, supervisor: childProcess.ChildProcess): boolean {
	return outcome.kind === "settled" || (outcome.kind === "failed" && supervisor.pid === undefined);
}

export async function stopSupervisor(
	supervisor: childProcess.ChildProcess,
	exited: Promise<unknown>,
	output: () => string,
) {
	// Observe rejection before tree termination yields; each bounded wait still uses the original result.
	void exited.catch(() => {});
	if (supervisor.pid !== undefined) {
		await terminateProcessTrees([supervisor.pid], { ownerPid: process.pid, graceMs: 1000 });
	}
	if (outcomeAllowsReturn(await settleWithin(SUPERVISOR_EXIT_DEADLINE_MS, exited), supervisor)) return;
	const group = supervisor.pid;
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (process.platform === "win32") supervisor.kill(signal);
		else if (group !== undefined && group > 0) signalGroup(group, signal);
		if (outcomeAllowsReturn(await settleWithin(SUPERVISOR_EXIT_DEADLINE_MS, exited), supervisor)) return;
	}
	throw new Error(
		`supervisor did not exit within ${3 * SUPERVISOR_EXIT_DEADLINE_MS} ms of cleanup (tree stop, SIGTERM, SIGKILL) or its exit could not be confirmed:\n${output()}`,
	);
}
