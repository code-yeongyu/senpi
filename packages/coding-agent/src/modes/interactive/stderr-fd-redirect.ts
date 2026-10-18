/**
 * File-descriptor-level stderr capture for the interactive TUI (#2284).
 *
 * The JS guard in `interactive-stderr-guard.ts` only sees `process.stderr.write` and the
 * main thread's `console`. Bun's native unhandled-error printer, Worker-thread `console.*`,
 * and children spawned with `stderr: "inherit"` write fd 2 directly, which is the terminal
 * the TUI is drawing on. While the TUI owns the screen, fd 2 is pointed at the debug log
 * with `dup2`, and the original descriptor is put back before the terminal is released.
 *
 * RUNTIME BOUNDARY (same sanctioned dynamic import as `rpc/child-reaper-syscalls.ts`):
 * `dup`/`dup2` need `bun:ffi`, a Bun-only builtin that is unloadable on Node. The loader
 * resolves to `undefined` on Node, Windows, or a libc without the symbols, and the JS guard
 * alone stays in force there.
 */
import { closeSync, openSync } from "node:fs";

const STDERR_FD = 2;

export interface StderrFdSyscalls {
	dup(fd: number): number;
	dup2(source: number, target: number): number;
	close(fd: number): number;
}

export interface StderrFdRedirect {
	restore(): void;
}

export async function loadStderrFdSyscalls(platform = process.platform): Promise<StderrFdSyscalls | undefined> {
	if (platform !== "darwin" && platform !== "linux") return undefined;
	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return undefined;
	const { dlopen, FFIType } = await import("bun:ffi");
	try {
		const libc = dlopen(platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
			dup: { args: [FFIType.i32], returns: FFIType.i32 },
			dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			close: { args: [FFIType.i32], returns: FFIType.i32 },
		});
		return {
			dup: (fd) => libc.symbols.dup(fd),
			dup2: (source, target) => libc.symbols.dup2(source, target),
			close: (fd) => libc.symbols.close(fd),
		};
	} catch {
		return undefined;
	}
}

/**
 * Point fd 2 at `logPath` (append, 0600). Returns `undefined`, leaving fd 2 untouched, when any
 * step fails; the caller then keeps the JS-level guard only.
 */
export function redirectStderrFd(syscalls: StderrFdSyscalls, logPath: string): StderrFdRedirect | undefined {
	const saved = syscalls.dup(STDERR_FD);
	if (saved < 0) return undefined;
	let target: number;
	try {
		target = openSync(logPath, "a", 0o600);
	} catch {
		syscalls.close(saved);
		return undefined;
	}
	const moved = syscalls.dup2(target, STDERR_FD);
	closeSync(target);
	if (moved < 0) {
		syscalls.close(saved);
		return undefined;
	}
	let restored = false;
	return {
		restore() {
			if (restored) return;
			restored = true;
			syscalls.dup2(saved, STDERR_FD);
			syscalls.close(saved);
		},
	};
}
