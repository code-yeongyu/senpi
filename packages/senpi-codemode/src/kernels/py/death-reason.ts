import type { KernelMemoryReport } from "../../bridge/memory-protocol.ts";
import { describeExit } from "../shared/kernel-death.ts";
import { formatBytes } from "../shared/kernel-memory.ts";

/** Written by the prelude's parent watch (prelude.py `PARENT_WATCH_MARKER`) just before it kills its own group. */
const PARENT_WATCH_MARKER = "[senpi] parent watch:";

export interface PythonExit {
	readonly code: number | null;
	readonly signal: string | null;
}

/**
 * Why an interpreter the host did not retire is gone, for the restart notice: the prelude's own parent
 * watch names itself on stderr; anything else is its exit status, with the last memory the kernel
 * reported so a reader can tell whether its own size could explain a kill by the system.
 */
export function pythonDeathReason(stderrTail: string, exit: PythonExit, lastMemory?: KernelMemoryReport): string {
	const watch = stderrTail
		.split("\n")
		.find((line) => line.startsWith(PARENT_WATCH_MARKER))
		?.slice(PARENT_WATCH_MARKER.length)
		.trim();
	if (watch !== undefined) return `senpi's parent watch stopped it (${watch})`;
	const status = describeExit(exit.code, exit.signal);
	if (lastMemory === undefined) return status;
	const measure = lastMemory.measure === "heap" ? "live after GC" : "in its process footprint";
	return `${status} (its last reading was ${formatBytes(lastMemory.liveBytes)} ${measure})`;
}
