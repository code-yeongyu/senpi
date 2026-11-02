/**
 * File-descriptor-level stdout capture for the interactive TUI (#2815).
 *
 * The TUI draws on fd 1. Anything else that writes fd 1 directly while the TUI owns the screen (a
 * `writeSync(1, ...)`, a child spawned with `stdio: "inherit"`, Bun's native `console.log`, a Worker's
 * console) scrolls the real terminal behind the renderer's back. The renderer's cursor math then goes
 * stale and the editor is pushed below the visible screen. Mirroring the fd 2 capture
 * (`stderr-fd-redirect.ts`, #2284): while the TUI owns the screen, fd 1 is pointed at the debug log
 * with `dup2`, and `process.stdout` (the renderer's only writer) is re-pointed at a duplicate of the
 * terminal descriptor, so its writes, size and resize events keep coming from the terminal itself.
 * The original fd 1 is put back before the terminal is released.
 *
 * Only the interactive TUI installs this. Print, JSON and RPC modes use stdout as their protocol and
 * never call it. Windows has no `dup`/`dup2` here (`loadStderrFdSyscalls` returns undefined), so
 * the JS-level guard stays the only protection there.
 */
import { closeSync, createWriteStream, openSync } from "node:fs";
import { isatty, WriteStream as TtyWriteStream } from "node:tty";
import type { StderrFdSyscalls } from "./stderr-fd-redirect.ts";

const STDOUT_FD = 1;

type StdoutLike = NodeJS.WriteStream;
type TerminalStream = NodeJS.WritableStream & {
	readonly columns?: number;
	readonly rows?: number;
	_refreshSize?: () => void;
};

export interface StdoutFdRedirect {
	restore(): void;
}

interface TerminalHandle {
	readonly fd: number;
	readonly stream: TerminalStream;
}

// One duplicate of the terminal per process: every takeover after a suspend or an external editor
// reuses it, so a long session does not accumulate descriptors.
let terminal: TerminalHandle | undefined;

// Our `write` wrappers, and the `write` that was in place before the first of them. A release can leave
// an inactive wrapper installed (the renderer's own guard is removed after it); the next takeover wraps
// the base write instead, so suspend/resume cycles never stack wrappers.
const ownWrites = new WeakSet<object>();
let baseWrite: NodeJS.WriteStream["write"] | undefined;

function terminalHandle(syscalls: StderrFdSyscalls): TerminalHandle | undefined {
	if (terminal) return terminal;
	const fd = syscalls.dup(STDOUT_FD);
	if (fd < 0) return undefined;
	const stream: TerminalStream = isatty(fd) ? new TtyWriteStream(fd) : createWriteStream("", { fd, autoClose: false });
	terminal = { fd, stream };
	return terminal;
}

/**
 * Point fd 1 at `logPath` (append, 0600) and re-point `stdout` at a duplicate of the terminal.
 * Returns `undefined`, leaving fd 1 and `stdout` untouched, when any step fails.
 */
export function redirectStdoutFd(
	syscalls: StderrFdSyscalls,
	logPath: string,
	stdout: StdoutLike = process.stdout,
): StdoutFdRedirect | undefined {
	const handle = terminalHandle(syscalls);
	if (!handle) return undefined;
	let target: number;
	try {
		target = openSync(logPath, "a", 0o600);
	} catch {
		return undefined;
	}
	const moved = syscalls.dup2(target, STDOUT_FD);
	closeSync(target);
	if (moved < 0) return undefined;
	try {
		return installTerminalWriter(syscalls, handle, stdout);
	} catch {
		// Never leave fd 1 pointed at the log without a way back.
		syscalls.dup2(handle.fd, STDOUT_FD);
		return undefined;
	}
}

function installTerminalWriter(
	syscalls: StderrFdSyscalls,
	handle: TerminalHandle,
	stdout: StdoutLike,
): StdoutFdRedirect {
	let active = true;
	if (!ownWrites.has(stdout.write)) baseWrite = stdout.write;
	const originalWrite = baseWrite ?? stdout.write;
	const write = function (this: unknown, ...args: unknown[]): boolean {
		if (!active) return (originalWrite as (...rest: unknown[]) => boolean).apply(stdout, args);
		return (handle.stream.write as (...rest: unknown[]) => boolean).apply(handle.stream, args);
	} as typeof stdout.write;
	ownWrites.add(write);
	stdout.write = write;

	// fd 1 is a file now, so the stream's own size reads would come back empty: read the terminal's.
	const sizeProperties = ["columns", "rows"] as const;
	const ownDescriptors = new Map(
		sizeProperties.map((name) => [name, Object.getOwnPropertyDescriptor(stdout, name)] as const),
	);
	for (const name of sizeProperties) {
		Object.defineProperty(stdout, name, {
			configurable: true,
			enumerable: true,
			get: () => handle.stream[name],
		});
	}
	const onWindowChange = () => {
		handle.stream._refreshSize?.();
		stdout.emit("resize");
	};
	process.on("SIGWINCH", onWindowChange);

	return {
		restore() {
			if (!active) return;
			active = false;
			process.removeListener("SIGWINCH", onWindowChange);
			syscalls.dup2(handle.fd, STDOUT_FD);
			// A wrapper installed on top of ours (the renderer's own guard) keeps calling `write`, which
			// now forwards to the original stdout on the restored fd 1.
			if (stdout.write === write) stdout.write = originalWrite;
			for (const name of sizeProperties) {
				const descriptor = ownDescriptors.get(name);
				if (descriptor) Object.defineProperty(stdout, name, descriptor);
				else delete (stdout as unknown as Record<string, unknown>)[name];
			}
		},
	};
}
