import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Linux `oom_score_adj` for every command a machine exec starts: the maximum, so under memory pressure the kernel's
 * OOM killer picks a runaway command (and the descendants it forks afterwards, which inherit the value) before the
 * long-lived host that ran it. Unprivileged processes may raise their children's value. This mirrors pi-pty's
 * terminal-session helper; exec.ts sits on the CLI startup graph, which must not load pi-pty (see pty.lazy.ts).
 */
const EXEC_CHILD_OOM_SCORE_ADJ = 1000;

/**
 * Marks `pid` as the preferred OOM victim on Linux; a no-op elsewhere. Best effort and never throws: the write lands
 * just after the spawn, so a process the child forked before it keeps the inherited value, and a child that already
 * exited (ENOENT/ESRCH) or a locked-down /proc (EACCES) is left as is.
 */
export function preferExecChildAsOomVictim(pid: number): void {
	if (process.platform !== "linux") return;
	try {
		writeFileSync(`/proc/${pid}/oom_score_adj`, String(EXEC_CHILD_OOM_SCORE_ADJ));
	} catch {
		// The spawn must not fail over a best-effort score.
	}
}
