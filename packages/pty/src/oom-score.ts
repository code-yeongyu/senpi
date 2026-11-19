import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Linux `oom_score_adj` for every child a terminal session starts: the maximum, so under memory pressure the
 * kernel's OOM killer picks a runaway tool process (and its descendants, which inherit the value) before the
 * long-lived host that spawned it. Unprivileged processes may raise their own children's value.
 */
export const TOOL_CHILD_OOM_SCORE_ADJ = 1000;

/** Marks `pid` as the preferred OOM victim on Linux; a no-op elsewhere or without a pid. Never throws. */
export function preferAsOomVictim(pid: number | undefined): void {
	if (process.platform !== "linux" || pid === undefined) return;
	try {
		writeFileSync(`/proc/${pid}/oom_score_adj`, String(TOOL_CHILD_OOM_SCORE_ADJ));
	} catch {
		// Best effort: a child that already exited (ENOENT/ESRCH) or a locked-down /proc (EACCES) keeps its
		// inherited value; the spawn itself must not fail over it.
	}
}
