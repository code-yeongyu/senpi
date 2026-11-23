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

/** Signals the owned supervisor's own process group (its spawn is detached), or the child itself on win32. */
function signalOwned(supervisor: childProcess.ChildProcess, signal: NodeJS.Signals): void {
	const pid = supervisor.pid;
	if (pid === undefined || pid <= 0) return;
	if (process.platform === "win32") {
		if (!supervisor.kill(signal)) throw new Error(`${signal} was not delivered to supervisor ${pid}`);
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
	}
}

/** The supervisor's own exit has not been observed: it is still the live process this cleanup owns. */
const stillRunning = (supervisor: childProcess.ChildProcess) =>
	supervisor.pid !== undefined && supervisor.exitCode === null && supervisor.signalCode === null;

const observedExit = (supervisor: childProcess.ChildProcess) =>
	new Promise<void>((resolve) => {
		if (!stillRunning(supervisor)) resolve();
		else supervisor.once("exit", () => resolve());
	});

/**
 * A wait that settled, a spawn that never produced a pid, or an exit the child process already reported ends cleanup.
 * A rejected wait for a supervisor still running is not one of them (senpi#4703).
 */
const stopped = (outcome: WaitOutcome, supervisor: childProcess.ChildProcess) =>
	outcome.kind === "settled" || !stillRunning(supervisor);

export async function stopSupervisor(
	supervisor: childProcess.ChildProcess,
	exited: Promise<unknown>,
	output: () => string,
) {
	// A lost or rejected wait is not an exit: every bounded wait also watches the child's own exit event, and the
	// rejection is observed here, before tree termination yields, so it is never reported as unhandled.
	void exited.catch(() => {});
	const exit = Promise.any([exited, observedExit(supervisor)]);
	if (supervisor.pid !== undefined) {
		await terminateProcessTrees([supervisor.pid], { ownerPid: process.pid, graceMs: 1000 });
	}
	if (stopped(await settleWithin(SUPERVISOR_EXIT_DEADLINE_MS, exit), supervisor)) return;
	const failures: unknown[] = [];
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (!stillRunning(supervisor)) return;
		try {
			signalOwned(supervisor, signal);
		} catch (cause) {
			// Nothing was delivered, so there is nothing to wait for: escalate at once and keep the failure.
			failures.push(cause);
			continue;
		}
		if (stopped(await settleWithin(SUPERVISOR_EXIT_DEADLINE_MS, exit), supervisor)) return;
	}
	throw new Error(
		`supervisor did not exit within ${3 * SUPERVISOR_EXIT_DEADLINE_MS} ms of cleanup (tree stop, SIGTERM, SIGKILL) or its exit could not be confirmed:\n${output()}`,
		failures.length === 0 ? undefined : { cause: failures.length === 1 ? failures[0] : new AggregateError(failures) },
	);
}
