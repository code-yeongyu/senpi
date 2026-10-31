import type { ChildProcess } from "node:child_process";

/**
 * Signal a child process only if it really started.
 *
 * A child whose spawn failed (ENOENT, EACCES, EMFILE, a missing cwd) has no pid. On Node before 24.22.0 / 26.10.0
 * (nodejs/node#65052), `kill()` on such a child becomes `kill(0, signal)`, which signals the caller's own process
 * group: senpi itself and everything else in the terminal's foreground job. A child that never started has nothing
 * to stop, so nothing is sent and the call reports `false`.
 */
export function signalSpawnedChild(
	child: Pick<ChildProcess, "pid"> & { kill(signal?: NodeJS.Signals): unknown },
	signal?: NodeJS.Signals,
): boolean {
	if (child.pid === undefined) return false;
	return child.kill(signal) === true;
}
