/**
 * IS-6: a graceful stop of a host child that is alive but measurably stalled WAITS for it instead of
 * SIGKILLing it after five seconds - a stalled host is still serving, and the SIGTERM it was sent is
 * handled the moment its loop runs again. The wait is bounded (`SENPI_RPC_CHILD_STALLED_STOP_MAX_MS`),
 * re-reads the evidence every slice, and is reported in `stop-progress.json` so a caller holding a
 * deadline on this supervisor extends it instead of killing the supervisor mid-wait (senpi#2566).
 */
import type { ChildProcess } from "node:child_process";
import type { HostGenerationPaths } from "./host-daemon-paths.ts";
import {
	CHILD_STALLED_STOP_MAX_MS_ENV,
	childStalledStopMaxMs,
	clearStopProgress,
	hostLoopStalled,
	STOP_STALL_EVIDENCE_MAX_AGE_MS,
	writeStopProgress,
} from "./host-stalled-evidence.ts";
import { supervisorLog } from "./host-supervisor-log.ts";
import { loopLagErrorMs } from "./loop-lag-threshold.ts";

const STALL_WAIT_SLICE_MS = 5_000;

/**
 * Waits past the ordinary stop window while the child stays stalled, in slices, up to the bound
 * measured from `signalledAt`. Returns how long it waited beyond the ordinary window (0 when the child
 * was not stalled at all, so the ordinary escalation is unchanged).
 */
export async function waitOutStalledChild(options: {
	readonly child: ChildProcess;
	readonly generation: HostGenerationPaths;
	readonly signalledAt: number;
	readonly waitForExit: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
}): Promise<number> {
	const { child, generation, signalledAt } = options;
	const maxMs = childStalledStopMaxMs();
	const untilAt = signalledAt + maxMs;
	const stalled = () =>
		hostLoopStalled(generation, {
			now: Date.now(),
			errorMs: loopLagErrorMs(),
			windowMs: STOP_STALL_EVIDENCE_MAX_AGE_MS,
		}).catch(() => false);
	let waited = 0;
	try {
		while (Date.now() < untilAt && (await stalled())) {
			if (waited === 0)
				supervisorLog(`host child is stalled; waiting up to ${maxMs}ms (${CHILD_STALLED_STOP_MAX_MS_ENV})`);
			await writeStopProgress(generation, {
				at: new Date().toISOString(),
				phase: "waiting_stalled_child",
				untilAt: new Date(untilAt).toISOString(),
			}).catch(() => undefined);
			const slice = Math.min(STALL_WAIT_SLICE_MS, untilAt - Date.now());
			const exited = await options.waitForExit(child, slice);
			waited += slice;
			if (exited) break;
		}
	} finally {
		await clearStopProgress(generation);
	}
	return waited;
}
