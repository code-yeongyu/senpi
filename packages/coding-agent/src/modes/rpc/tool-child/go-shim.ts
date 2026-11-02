/**
 * The POSIX go-line shim every own-group launch starts through (senpi#3566 todo 4; review MEDIUM 4). The shim leads the
 * new process group and waits for `go` on a dedicated control descriptor - never stdin, which stays the caller's - so
 * the command runs only after the server recorded the launch. A program that cannot be found is reported back on the
 * same descriptor (`ENOENT`) before the shim exits, so the caller sees the same ENOENT `'error'` as an ungated spawn.
 * The descriptor is closed before the command starts, so the command never sees it.
 *
 * Measured on Node and Bun 1.4: an extra `"pipe"` stdio entry is bidirectional on both (a socket on Node, an fd number
 * on Bun).
 */

/** The shell script for a control descriptor `fd` (3 or above). `$0` is the program, `$@` its arguments. */
export function goShimScript(fd: number): string {
	return [
		`IFS= read -r _go <&${fd} || exit 127`,
		`command -v "$0" >/dev/null 2>&1 || { printf 'ENOENT\\n' >&${fd}; exit 127; }`,
		`exec "$0" "$@" ${fd}<&-`,
	].join("; ");
}

/** The control descriptor for a launch: the first index after every descriptor the caller already asked for. */
export function controlFd(callerStdio: readonly unknown[]): number {
	return Math.max(3, callerStdio.length);
}

/** The caller's stdio padded to `fd` entries, with the control pipe at `fd`. */
export function withControlPipe<T>(callerStdio: readonly T[], fd: number, pad: T, pipe: T): T[] {
	const stdio = [...callerStdio];
	while (stdio.length < fd) stdio.push(pad);
	stdio.push(pipe);
	return stdio;
}

/** The program and arguments the shim execs: the command itself, or the caller's shell running it. */
export function shimTarget(
	command: string,
	args: readonly string[],
	shell: boolean | string | undefined,
): { readonly program: string; readonly args: readonly string[] } {
	if (shell === undefined || shell === false) return { program: command, args };
	return { program: typeof shell === "string" ? shell : "/bin/sh", args: ["-c", [command, ...args].join(" ")] };
}

/** The error an ungated spawn emits for a program it cannot find. */
export function enoentError(command: string, args: readonly string[]): NodeJS.ErrnoException {
	return Object.assign(new Error(`spawn ${command} ENOENT`), {
		errno: -2,
		code: "ENOENT",
		syscall: `spawn ${command}`,
		path: command,
		spawnargs: [...args],
	});
}
