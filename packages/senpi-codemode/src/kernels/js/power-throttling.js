// senpi#6125: the eval kernel's realms opt their children out of Windows EcoQoS throttling, as senpi's own entries do
// (packages/coding-agent/src/core/windows-power-throttling.ts). Plain JS (with power-throttling.d.ts) because the worker
// and process kernel entries import it before interpose.js captures the launchers. The policy is per process and not
// inherited, and the launcher patch is per JavaScript realm, so each kernel realm installs its own. A no-op off Windows,
// without bun:ffi, or with SENPI_KEEP_POWER_THROTTLING=1.
import { ChildProcess } from "node:child_process";

const PROCESS_POWER_THROTTLING_CLASS = 4;
const PROCESS_SET_INFORMATION = 0x0200;

function optOutState() {
	const info = new Uint8Array(12);
	const view = new DataView(info.buffer);
	view.setUint32(0, 1, true);
	view.setUint32(4, 1, true);
	return info;
}

export function loadKernel32PowerThrottling(platform = process.platform) {
	if (platform !== "win32") return undefined;
	const ffi = process.getBuiltinModule("bun:ffi");
	if (ffi === undefined) return undefined;
	let lib;
	try {
		lib = ffi.dlopen("kernel32.dll", {
			OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
			SetProcessInformation: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
			CloseHandle: { args: ["ptr"], returns: "i32" },
		});
	} catch {
		// A kernel32 without these exports (pre-Windows 8): keep Windows' default policy rather than fail the kernel.
		return undefined;
	}
	return {
		OpenProcess: (access, inherit, pid) => lib.symbols.OpenProcess(access, inherit, pid),
		SetProcessInformation: (handle, infoClass, info, length) =>
			Number(lib.symbols.SetProcessInformation(handle, infoClass, ffi.ptr(info), length)),
		CloseHandle: (handle) => Number(lib.symbols.CloseHandle(handle)),
	};
}

export function disableExecutionSpeedThrottling(kernel, pid) {
	try {
		const handle = kernel.OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
		if (!handle) return false;
		try {
			const info = optOutState();
			return kernel.SetProcessInformation(handle, PROCESS_POWER_THROTTLING_CLASS, info, info.byteLength) !== 0;
		} finally {
			kernel.CloseHandle(handle);
		}
	} catch {
		// The child is already running: an FFI failure must never turn its launch into an exception.
		return false;
	}
}

export function installKernelPowerThrottlingOptOut(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return { status: "skipped", reason: "not-windows" };
	if ((options.env ?? process.env).SENPI_KEEP_POWER_THROTTLING === "1") return { status: "skipped", reason: "opted-out" };
	const kernel = (options.load ?? loadKernel32PowerThrottling)(platform);
	if (kernel === undefined) return { status: "skipped", reason: "no-ffi" };
	const self = disableExecutionSpeedThrottling(kernel, options.pid ?? process.pid);
	const proto = options.childProcessPrototype ?? ChildProcess.prototype;
	const bun = options.bun ?? globalThis.Bun;
	const optOut = (pid) => {
		if (typeof pid === "number" && pid > 0) disableExecutionSpeedThrottling(kernel, pid);
	};
	const originalSpawn = proto.spawn;
	proto.spawn = function (...args) {
		const result = originalSpawn.apply(this, args);
		optOut(this.pid);
		return result;
	};
	const originalBunSpawn = bun?.spawn;
	if (originalBunSpawn !== undefined) {
		bun.spawn = function (...args) {
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
			if (originalBunSpawn !== undefined) bun.spawn = originalBunSpawn;
		},
	};
}
