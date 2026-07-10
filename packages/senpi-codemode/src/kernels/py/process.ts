import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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

export class PythonKernelRetirementError extends Error {
	constructor(pid: number | undefined) {
		super(`Python kernel process${pid === undefined ? "" : ` ${pid}`} did not exit after SIGKILL`);
		this.name = "PythonKernelRetirementError";
	}
}

export function defaultSpawn(options: KernelSpawnOptions): KernelChild {
	return spawn(options.command, [...options.args], {
		cwd: options.cwd,
		env: options.env,
		stdio: "pipe",
		detached: process.platform !== "win32",
		windowsHide: true,
	});
}

export function splitCommand(commandLine: string): { readonly command: string; readonly args: readonly string[] } {
	const [command, ...args] = commandLine.split(" ").filter(Boolean);
	if (!command) throw new Error("Python interpreter path is empty");
	return { command, args };
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

export async function hardKill(child: KernelChild, timeoutMs: number): Promise<void> {
	const exited = waitForExit(child, timeoutMs);
	if (child.pid !== undefined && process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			child.kill("SIGKILL");
		}
	} else {
		child.kill("SIGKILL");
	}
	if (!(await exited)) throw new PythonKernelRetirementError(child.pid);
}
