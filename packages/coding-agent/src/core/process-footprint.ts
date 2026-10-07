/**
 * How much memory a process really holds, read from the kernel without spawning anything.
 *
 * RSS is the wrong meter for a long-lived Bun process: after a collection returns memory, the
 * freed pages stay counted as resident (macOS keeps them until the system reclaims them), so RSS
 * reads gigabytes long after the process gave them back (senpi#2261 measured 2314 MB RSS against a
 * 143 MB footprint after an eval kernel reset). What Activity Monitor and the OS memory pressure act
 * on is the footprint, so that is what this module reports:
 *
 * - darwin: `phys_footprint` from `proc_pid_rusage(pid, RUSAGE_INFO_V2)` (libproc, via `bun:ffi`);
 * - linux: `RssAnon` from `/proc/<pid>/status` (anonymous resident memory, no file-backed pages);
 * - win32: `PrivateUsage` from `K32GetProcessMemoryInfo` (kernel32, via `bun:ffi`);
 * - anything else, or a runtime without the bindings: `process.memoryUsage.rss()` for this process
 *   (`measure: "rss"`), and `undefined` for any other pid.
 *
 * Every read is synchronous, never spawns a child (a probe process per read is the zombie bug
 * omo-desktop#594 fixed) and never throws.
 *
 * RUNTIME BOUNDARY: the darwin and win32 bindings need `bun:ffi`, a Bun-only builtin whose
 * top-level import makes a module unloadable on Node. It is fetched with
 * `process.getBuiltinModule("bun:ffi")`, which answers synchronously on Bun and `undefined` on
 * Node, so a Node caller falls back to RSS instead of failing to load (the same boundary
 * `extensions/loader.ts` uses for `node:sea`).
 */
import { readFileSync } from "node:fs";

/** Which kernel counter `bytes` came from; `"rss"` means no footprint counter was readable. */
export type ProcessFootprintMeasure = "phys_footprint" | "rss_anon" | "private_usage" | "rss";

export interface ProcessFootprint {
	readonly bytes: number;
	readonly measure: ProcessFootprintMeasure;
}

type BunFfi = typeof import("bun:ffi");
type PlatformFootprintReader = (pid: number) => ProcessFootprint | undefined;

/** `proc_pid_rusage` flavor and the `rusage_info_v2.ri_phys_footprint` byte offset. */
const RUSAGE_INFO_V2 = 2;
const RI_PHYS_FOOTPRINT_OFFSET = 72;
/** `rusage_info_v2` is 160 bytes; the buffer leaves room for any larger layout. */
const RUSAGE_BUFFER_BYTES = 256;
/** `OpenProcess` access right that is enough for `K32GetProcessMemoryInfo`. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** 64-bit `PROCESS_MEMORY_COUNTERS_EX`: its size and the `PrivateUsage` byte offset. */
const MEMORY_COUNTERS_EX_BYTES = 80;
const PRIVATE_USAGE_OFFSET = 72;

let platformReader: PlatformFootprintReader | null | undefined;

/** The memory footprint of this process. Always answers: RSS when no footprint counter is readable. */
export function readOwnFootprint(): ProcessFootprint {
	return readProcessFootprint(process.pid) ?? { bytes: process.memoryUsage.rss(), measure: "rss" };
}

/**
 * The memory footprint of `pid`, or `undefined` when it cannot be read (the process is gone, is not
 * ours to inspect, or this runtime has no footprint counter). For this process's own pid on such a
 * runtime the answer is its RSS, labelled `measure: "rss"`.
 */
export function readProcessFootprint(pid: number): ProcessFootprint | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const reading = loadPlatformReader()?.(pid);
	if (reading !== undefined || pid !== process.pid) return reading;
	return { bytes: process.memoryUsage.rss(), measure: "rss" };
}

/** Anonymous resident memory in bytes from `/proc/<pid>/status` text, or `undefined` when absent. */
export function parseProcStatusRssAnon(status: string): number | undefined {
	const match = /^RssAnon:\s+(\d+)\s+kB$/m.exec(status);
	return match?.[1] === undefined ? undefined : Number(match[1]) * 1024;
}

function loadPlatformReader(): PlatformFootprintReader | undefined {
	if (platformReader === undefined) platformReader = createPlatformReader() ?? null;
	return platformReader ?? undefined;
}

function createPlatformReader(): PlatformFootprintReader | undefined {
	if (process.platform === "linux") return linuxReader;
	if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	try {
		return process.platform === "darwin" ? darwinReader(ffi) : windowsReader(ffi);
	} catch {
		// A library or symbol this build cannot bind: report RSS rather than fail the caller.
		return undefined;
	}
}

function linuxReader(pid: number): ProcessFootprint | undefined {
	let status: string;
	try {
		status = readFileSync(`/proc/${pid}/status`, "utf8");
	} catch {
		// The process is gone (or /proc is not mounted).
		return undefined;
	}
	const bytes = parseProcStatusRssAnon(status);
	return bytes === undefined ? undefined : { bytes, measure: "rss_anon" };
}

function darwinReader({ dlopen, FFIType, ptr }: BunFfi): PlatformFootprintReader {
	const library = dlopen("libSystem.B.dylib", {
		proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	});
	const buffer = new Uint8Array(RUSAGE_BUFFER_BYTES);
	const view = new DataView(buffer.buffer);
	return (pid) => {
		buffer.fill(0);
		if (library.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V2, ptr(buffer)) !== 0) return undefined;
		return { bytes: Number(view.getBigUint64(RI_PHYS_FOOTPRINT_OFFSET, true)), measure: "phys_footprint" };
	};
}

function windowsReader({ dlopen, FFIType, ptr }: BunFfi): PlatformFootprintReader {
	const library = dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const counters = new Uint8Array(MEMORY_COUNTERS_EX_BYTES);
	const view = new DataView(counters.buffer);
	return (pid) => {
		const handle = library.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		// A null HANDLE (Bun returns `null` for a zero pointer): no such process, or not ours.
		if (!handle) return undefined;
		try {
			counters.fill(0);
			if (library.symbols.K32GetProcessMemoryInfo(handle, ptr(counters), counters.byteLength) === 0) {
				return undefined;
			}
			return { bytes: Number(view.getBigUint64(PRIVATE_USAGE_OFFSET, true)), measure: "private_usage" };
		} finally {
			library.symbols.CloseHandle(handle);
		}
	};
}
