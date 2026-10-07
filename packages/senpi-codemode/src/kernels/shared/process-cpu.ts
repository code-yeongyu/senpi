/**
 * CPU time a kernel child has used so far, in platform units that only ever grow; a watchdog compares
 * two readings and never converts.
 *
 * - linux and darwin: the child's whole process group (`readProcessGroupCpuTime`), so a helper process
 *   the runner forks counts as activity. The kernel child is spawned detached, so its pid is its pgid.
 * - win32 under Bun: the child's own kernel + user time from `GetProcessTimes` (kernel32, via `bun:ffi`).
 *   Windows has no process groups; this is the interpreter itself when it is launched directly.
 * - anything else, or Windows under Node: `undefined`, and the caller treats the CPU as unknown.
 */
import { readProcessGroupCpuTime } from "./process-group-cpu.ts";

type BunFfi = typeof import("bun:ffi");
type CpuReader = (pid: number) => bigint | undefined;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const FILETIME_BYTES = 8;

let windowsReader: CpuReader | null | undefined;

export function readKernelCpuTime(pid: number): bigint | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform !== "win32") return readProcessGroupCpuTime(pid);
	if (windowsReader === undefined) windowsReader = createWindowsReader() ?? null;
	return windowsReader?.(pid);
}

function createWindowsReader(): CpuReader | undefined {
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	try {
		return bindGetProcessTimes(ffi);
	} catch {
		// kernel32 always exports these; a binding failure means this runtime cannot call it at all.
		return undefined;
	}
}

function bindGetProcessTimes({ dlopen, FFIType, ptr }: BunFfi): CpuReader {
	const library = dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		GetProcessTimes: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const times = new Uint8Array(FILETIME_BYTES * 4);
	const view = new DataView(times.buffer);
	return (pid) => {
		const handle = library.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if (!handle) return undefined;
		try {
			times.fill(0);
			const base = ptr(times);
			const ok = library.symbols.GetProcessTimes(
				handle,
				base,
				base + FILETIME_BYTES,
				base + FILETIME_BYTES * 2,
				base + FILETIME_BYTES * 3,
			);
			if (ok === 0) return undefined;
			return view.getBigUint64(FILETIME_BYTES * 2, true) + view.getBigUint64(FILETIME_BYTES * 3, true);
		} finally {
			library.symbols.CloseHandle(handle);
		}
	};
}
