import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type Readable, Writable } from "node:stream";

export interface KernelChild {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly pid?: number;
	readonly killed: boolean;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: string, listener: (...args: unknown[]) => void): this;
	once(event: string, listener: (...args: unknown[]) => void): this;
	off(event: string, listener: (...args: unknown[]) => void): this;
}

export interface KernelSpawnOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export type KernelSpawnProcess = (options: KernelSpawnOptions) => KernelChild;

/** Signals a kernel's whole process group (addressed by its leader pid); throws like `process.kill`. */
export type KillProcessGroup = (pid: number, signal: NodeJS.Signals) => void;

export const killProcessGroup: KillProcessGroup = (pid, signal) => {
	process.kill(-pid, signal);
};

export class PythonKernelRetirementError extends Error {
	constructor(pid: number | undefined) {
		super(`Python kernel process${pid === undefined ? "" : ` ${pid}`} did not exit after SIGKILL`);
		this.name = "PythonKernelRetirementError";
	}
}

/** The descriptor the kernel reads host frames from; see {@link defaultSpawn}. */
export const PY_CONTROL_FD = 3;

export function defaultSpawn(options: KernelSpawnOptions): KernelChild {
	// Detached children survive their host, so the prelude needs the host pid to
	// watch for a parent that is already gone by the time the interpreter boots.
	const env = {
		...options.env,
		...(process.platform === "win32" ? {} : { SENPI_PY_KERNEL_PARENT_PID: String(process.pid) }),
		SENPI_PY_CONTROL_FD: String(PY_CONTROL_FD),
	};
	// The control pipe is the kernel's alone by design (senpi#2980): stdin is the null device, which is all a cell's
	// child inherits by default, and host frames travel on their own descriptor, which the prelude makes non-inheritable.
	const child = spawn(options.command, [...options.args], {
		cwd: options.cwd,
		env,
		stdio: ["ignore", "pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	globalThis.__senpiCodemodeGateObserveResource?.("processes", child, "close");
	const control = child.stdio[PY_CONTROL_FD];
	if (!(control instanceof Writable) || child.stdout === null || child.stderr === null)
		throw new Error("Python kernel pipes were not created");
	return withControlPipe(child, control, child.stdout, child.stderr);
}

/** The kernel as the host drives it: `stdin` is the control pipe, everything else is the child itself. */
function withControlPipe(
	child: ChildProcess,
	control: Writable,
	stdout: Readable,
	stderr: Readable,
): KernelChild & { unref(): void } {
	const kernel = {
		stdin: control,
		stdout,
		stderr,
		get pid() {
			return child.pid;
		},
		get killed() {
			return child.killed;
		},
		kill: (signal?: NodeJS.Signals) => child.kill(signal),
		unref: () => child.unref(),
		on(event: string, listener: (...args: unknown[]) => void) {
			child.on(event, listener);
			return kernel;
		},
		once(event: string, listener: (...args: unknown[]) => void) {
			child.once(event, listener);
			return kernel;
		},
		off(event: string, listener: (...args: unknown[]) => void) {
			child.off(event, listener);
			return kernel;
		},
	};
	return kernel;
}

export function splitCommand(commandLine: string): { readonly command: string; readonly args: readonly string[] } {
	// A configured interpreter path is one executable even when it contains spaces.
	if (isAbsolute(commandLine) && existsSync(commandLine)) return { command: commandLine, args: [] };
	const [command, ...args] = commandLine.split(" ").filter(Boolean);
	if (!command) throw new Error("Python interpreter path is empty");
	return { command, args };
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

export function numberOrNull(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

export function signalOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function waitForExit(child: KernelChild, timeoutMs: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const settle = (exited: boolean) => {
			child.off("exit", onExit);
			if (timer) clearTimeout(timer);
			resolve(exited);
		};
		const onExit = () => settle(true);
		child.on("exit", onExit);
		timer = setTimeout(() => settle(false), timeoutMs);
		timer.unref?.();
	});
}

// A cell's own subprocess is spawned into the detached kernel's process group. When the
// leader exits gracefully on close, kill the group so a Popen the cell left running does
// not outlive the kernel; the group is addressed by the leader pid (== pgid) while members live.
export function sweepProcessGroup(child: KernelChild, killGroup: KillProcessGroup = killProcessGroup): void {
	if (child.pid === undefined || process.platform === "win32") return;
	try {
		killGroup(child.pid, "SIGKILL");
	} catch (error) {
		// ESRCH means the group is already gone (the success case). Any other error
		// (for example EPERM on a member we cannot signal) must not fail a graceful close.
		if (errorCode(error) !== "ESRCH") return;
	}
}

export async function hardKill(
	child: KernelChild,
	timeoutMs: number,
	killGroup: KillProcessGroup = killProcessGroup,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			child.off("exit", onExit);
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const onExit = () => settle();
		child.on("exit", onExit);
		let signalDelivered = true;
		if (child.pid !== undefined && process.platform !== "win32") {
			try {
				killGroup(child.pid, "SIGKILL");
			} catch (error) {
				if (!(error instanceof Error)) {
					settle(new Error(String(error)));
					return;
				}
				signalDelivered = child.kill("SIGKILL");
			}
		} else {
			// A POSIX child that never started has no pid; on Node < 24.22 / 26.10 its kill() signals our own process group.
			signalDelivered = (child.pid !== undefined || process.platform === "win32") && child.kill("SIGKILL");
		}
		if (!signalDelivered) {
			settle();
			return;
		}
		if (settled) return;
		timer = setTimeout(() => settle(new PythonKernelRetirementError(child.pid)), timeoutMs);
		timer.unref?.();
	});
}
