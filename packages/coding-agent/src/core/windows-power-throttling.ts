/**
 * Windows EcoQoS opt-out (senpi#6125). When the launcher chain has no visible window, Windows classifies senpi and
 * every child it starts as background work and throttles them to a few percent of a core ("efficiency mode"). The
 * throttling state is decided per process and is NOT inherited, so the opt-out is applied twice:
 *
 * - to this process at startup, and
 * - to every child process this JavaScript realm starts, right after its pid is known: the hook wraps
 *   `ChildProcess.prototype.spawn` (which every async `node:child_process` launcher goes through: `spawn`, `exec`,
 *   `execFile`, `fork`) and `Bun.spawn`. Synchronous launchers are left alone: their child has already exited when a
 *   pid is returned.
 *
 * Each call is `SetProcessInformation(ProcessPowerThrottling, { Version: 1, ControlMask: EXECUTION_SPEED,
 * StateMask: 0 })` through `bun:ffi` (kernel32): no admin rights, no powercfg, no registry. A process handle is held by
 * the launcher until the child is reaped, so the pid cannot be reused between the spawn and the call.
 *
 * RUNTIME BOUNDARY: kernel32 is reached through `process.getBuiltinModule("bun:ffi")`, and only on win32. Off Windows,
 * on Node, or with `SENPI_KEEP_POWER_THROTTLING=1` nothing is loaded and nothing is patched.
 */
import { ChildProcess } from "node:child_process";

export const KEEP_POWER_THROTTLING_ENV = "SENPI_KEEP_POWER_THROTTLING";
/** `PROCESS_INFORMATION_CLASS.ProcessPowerThrottling`. */
export const PROCESS_POWER_THROTTLING_CLASS = 4;
export const PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
export const PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
/** `PROCESS_POWER_THROTTLING_STATE`: three ULONGs (Version, ControlMask, StateMask). */
export const POWER_THROTTLING_STATE_BYTES = 12;
export const PROCESS_SET_INFORMATION = 0x0200;
export const PROCESS_QUERY_INFORMATION = 0x0400;

export interface Kernel32PowerThrottling {
	OpenProcess(access: number, inherit: number, pid: number): unknown;
	SetProcessInformation(process: unknown, infoClass: number, info: Uint8Array, length: number): number;
	GetProcessInformation(process: unknown, infoClass: number, info: Uint8Array, length: number): number;
	CloseHandle(handle: unknown): number;
	GetLastError(): number;
}

export interface PowerThrottlingState {
	controlMask: number;
	stateMask: number;
}

export type PowerThrottlingResult = { ok: true } | { ok: false; step: string; win32Error: number };

export function executionSpeedOptOutState(): Uint8Array {
	const info = new Uint8Array(POWER_THROTTLING_STATE_BYTES);
	const view = new DataView(info.buffer);
	view.setUint32(0, PROCESS_POWER_THROTTLING_CURRENT_VERSION, true);
	view.setUint32(4, PROCESS_POWER_THROTTLING_EXECUTION_SPEED, true);
	view.setUint32(8, 0, true);
	return info;
}

export function disableExecutionSpeedThrottling(kernel: Kernel32PowerThrottling, pid: number): PowerThrottlingResult {
	const handle = kernel.OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
	if (!handle) return { ok: false, step: "OpenProcess", win32Error: kernel.GetLastError() };
	try {
		const info = executionSpeedOptOutState();
		if (kernel.SetProcessInformation(handle, PROCESS_POWER_THROTTLING_CLASS, info, info.byteLength) === 0)
			return { ok: false, step: "SetProcessInformation", win32Error: kernel.GetLastError() };
		return { ok: true };
	} finally {
		kernel.CloseHandle(handle);
	}
}

/** Reads the explicit power-throttling policy of `pid`; a process left on automatic reads `ControlMask = 0`. */
export function readPowerThrottlingState(kernel: Kernel32PowerThrottling, pid: number): PowerThrottlingState {
	const handle = kernel.OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
	if (!handle) throw new Error(`OpenProcess(${pid}) failed (win32 error ${kernel.GetLastError()})`);
	try {
		const info = new Uint8Array(POWER_THROTTLING_STATE_BYTES);
		new DataView(info.buffer).setUint32(0, PROCESS_POWER_THROTTLING_CURRENT_VERSION, true);
		if (kernel.GetProcessInformation(handle, PROCESS_POWER_THROTTLING_CLASS, info, info.byteLength) === 0)
			throw new Error(`GetProcessInformation(${pid}) failed (win32 error ${kernel.GetLastError()})`);
		const view = new DataView(info.buffer);
		return { controlMask: view.getUint32(4, true), stateMask: view.getUint32(8, true) };
	} finally {
		kernel.CloseHandle(handle);
	}
}

interface BunFfi {
	dlopen(
		library: string,
		symbols: Record<string, { args: readonly string[]; returns: string }>,
	): { symbols: Record<string, (...args: unknown[]) => unknown> };
	ptr(value: Uint8Array): unknown;
}

/** kernel32's power-throttling calls, or `undefined` off Windows or without `bun:ffi` (never loads FFI elsewhere). */
export function loadKernel32PowerThrottling(
	platform: NodeJS.Platform = process.platform,
): Kernel32PowerThrottling | undefined {
	if (platform !== "win32") return undefined;
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	let lib: ReturnType<BunFfi["dlopen"]>;
	try {
		lib = ffi.dlopen("kernel32.dll", {
			OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
			SetProcessInformation: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
			GetProcessInformation: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
			CloseHandle: { args: ["ptr"], returns: "i32" },
			GetLastError: { args: [], returns: "u32" },
		});
	} catch {
		// A kernel32 without these exports (pre-Windows 8): keep Windows' default policy rather than fail startup.
		return undefined;
	}
	const call = (name: string, ...args: unknown[]): unknown => {
		const fn = lib.symbols[name];
		if (fn === undefined) throw new Error(`kernel32 has no ${name}`);
		return fn(...args.map((arg) => (arg instanceof Uint8Array ? ffi.ptr(arg) : arg)));
	};
	return {
		OpenProcess: (access, inherit, pid) => call("OpenProcess", access, inherit, pid),
		SetProcessInformation: (process, infoClass, info, length) =>
			Number(call("SetProcessInformation", process, infoClass, info, length)),
		GetProcessInformation: (process, infoClass, info, length) =>
			Number(call("GetProcessInformation", process, infoClass, info, length)),
		CloseHandle: (handle) => Number(call("CloseHandle", handle)),
		GetLastError: () => Number(call("GetLastError")),
	};
}

export interface SpawnSurfaces {
	childProcessPrototype: { spawn(...args: unknown[]): unknown; pid?: number };
	bun?: { spawn(...args: unknown[]): { pid?: number } };
}

export type PowerThrottlingInstall =
	| { status: "skipped"; reason: "not-windows" | "opted-out" | "no-ffi" }
	| { status: "installed"; self: PowerThrottlingResult; restore(): void };

export interface InstallOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	pid?: number;
	load?: (platform: NodeJS.Platform) => Kernel32PowerThrottling | undefined;
	surfaces?: SpawnSurfaces;
}

function defaultSurfaces(): SpawnSurfaces {
	const bun = (globalThis as { Bun?: { spawn(...args: unknown[]): { pid?: number } } }).Bun;
	return {
		childProcessPrototype: ChildProcess.prototype as unknown as SpawnSurfaces["childProcessPrototype"],
		...(bun === undefined ? {} : { bun }),
	};
}

/**
 * Opts this process out of EcoQoS and wraps this realm's launchers so every child gets the same call. A failure for
 * one child (it already exited, or it runs at a higher integrity level) leaves that child on Windows' default policy
 * and never fails the launch: the spawn result is returned unchanged.
 */
export function installWindowsPowerThrottlingOptOut(options: InstallOptions = {}): PowerThrottlingInstall {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return { status: "skipped", reason: "not-windows" };
	if ((options.env ?? process.env)[KEEP_POWER_THROTTLING_ENV] === "1")
		return { status: "skipped", reason: "opted-out" };
	const kernel = (options.load ?? loadKernel32PowerThrottling)(platform);
	if (kernel === undefined) return { status: "skipped", reason: "no-ffi" };
	const self = disableExecutionSpeedThrottling(kernel, options.pid ?? process.pid);
	const surfaces = options.surfaces ?? defaultSurfaces();
	const optOut = (pid: number | undefined): void => {
		if (typeof pid === "number" && pid > 0) disableExecutionSpeedThrottling(kernel, pid);
	};

	const proto = surfaces.childProcessPrototype;
	const originalSpawn = proto.spawn;
	proto.spawn = function (this: { pid?: number }, ...args: unknown[]): unknown {
		const result = originalSpawn.apply(this, args);
		optOut(this.pid);
		return result;
	};

	const bun = surfaces.bun;
	const originalBunSpawn = bun?.spawn;
	if (bun !== undefined && originalBunSpawn !== undefined) {
		bun.spawn = function (this: unknown, ...args: unknown[]): { pid?: number } {
			const subprocess = originalBunSpawn.apply(this, args);
			optOut(subprocess.pid);
			return subprocess;
		};
	}

	return {
		status: "installed",
		self,
		restore: () => {
			proto.spawn = originalSpawn;
			if (bun !== undefined && originalBunSpawn !== undefined) bun.spawn = originalBunSpawn;
		},
	};
}

let installed: PowerThrottlingInstall | undefined;

/** The startup entry: installs once per JavaScript realm; later calls return the first result. */
export function ensureWindowsPowerThrottlingOptOut(): PowerThrottlingInstall {
	installed ??= installWindowsPowerThrottlingOptOut();
	return installed;
}
