/**
 * CPU time a process group has used so far, read from the kernel without spawning anything, in
 * platform units that only ever grow: the startup watchdog compares two readings and never converts.
 *
 * - darwin: every member from `proc_listpgrppids`, each `ri_user_time + ri_system_time` from
 *   `proc_pid_rusage(RUSAGE_INFO_V2)` (libproc, via `bun:ffi`);
 * - linux: every `/proc/<pid>/stat` whose process group is `pgid`, `utime + stime` in clock ticks;
 * - darwin on a runtime without `bun:ffi` (Node): the members' `cputime` from one `ps` call, in
 *   hundredths of a second;
 * - win32 and anything else: `undefined`. Windows has no process groups, and the launcher's own time
 *   misses the interpreter a launcher such as juliaup starts, so the caller treats the CPU as unknown.
 *
 * `bun:ffi` is fetched with `process.getBuiltinModule` so the module still loads on Node, the same
 * runtime boundary `process-footprint.ts` in coding-agent uses. Every read is synchronous and never throws.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { type BunFfi, loadBunFfi } from "./bun-ffi.ts";

type GroupCpuReader = (pgid: number) => bigint | undefined;

const RUSAGE_INFO_V2 = 2;
const RI_USER_TIME_OFFSET = 16;
const RI_SYSTEM_TIME_OFFSET = 24;
const RUSAGE_BUFFER_BYTES = 256;
const MAX_GROUP_MEMBERS = 4096;
const PS_TIMEOUT_MS = 2_000;

let groupReader: GroupCpuReader | null | undefined;

export function readProcessGroupCpuTime(pgid: number): bigint | undefined {
	if (!Number.isInteger(pgid) || pgid <= 0) return undefined;
	if (groupReader === undefined) groupReader = createGroupReader() ?? null;
	return groupReader?.(pgid);
}

/** `utime + stime` and the process group from `/proc/<pid>/stat` text, or `undefined` when malformed. */
export function parseProcStat(stat: string): { readonly pgrp: number; readonly cpuTicks: bigint } | undefined {
	// The command name may itself contain spaces or parentheses: the fields start after the last ")".
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const pgrp = Number(fields[2]);
	const utime = fields[11];
	const stime = fields[12];
	if (!Number.isInteger(pgrp) || utime === undefined || stime === undefined) return undefined;
	if (!/^\d+$/.test(utime) || !/^\d+$/.test(stime)) return undefined;
	return { pgrp, cpuTicks: BigInt(utime) + BigInt(stime) };
}

/** `ps` `cputime` (`[[hh:]mm:]ss.cc`) in hundredths of a second, or `undefined` when malformed. */
export function parsePsCpuTime(text: string): bigint | undefined {
	const match = /^(?:(\d+):)?(?:(\d+):)?(\d+)\.(\d{2})$/.exec(text.trim());
	if (match === null) return undefined;
	const [, first, second, seconds, hundredths] = match;
	const hours = second === undefined ? 0 : Number(first ?? 0);
	const minutes = second === undefined ? Number(first ?? 0) : Number(second);
	return BigInt(((hours * 60 + minutes) * 60 + Number(seconds)) * 100 + Number(hundredths));
}

function createGroupReader(): GroupCpuReader | undefined {
	if (process.platform === "linux") return linuxGroupReader;
	if (process.platform !== "darwin") return undefined;
	const ffi = loadBunFfi();
	if (ffi === undefined) return darwinPsGroupReader;
	try {
		return darwinGroupReader(ffi);
	} catch {
		// A library or symbol this build cannot bind: read the group through ps instead.
		return darwinPsGroupReader;
	}
}

function darwinPsGroupReader(pgid: number): bigint | undefined {
	let listing: string;
	try {
		listing = execFileSync("ps", ["-A", "-o", "pgid=,cputime="], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
	} catch {
		return undefined;
	}
	let total = 0n;
	let members = 0;
	for (const line of listing.split("\n")) {
		const [group, cputime] = line.trim().split(/\s+/);
		if (group !== String(pgid) || cputime === undefined) continue;
		const used = parsePsCpuTime(cputime);
		if (used === undefined) continue;
		total += used;
		members += 1;
	}
	return members === 0 ? undefined : total;
}

function linuxGroupReader(pgid: number): bigint | undefined {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return undefined;
	}
	let total = 0n;
	let members = 0;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${entry}/stat`, "utf8");
		} catch {
			// The process exited between the directory read and this one.
			continue;
		}
		const parsed = parseProcStat(stat);
		if (parsed === undefined || parsed.pgrp !== pgid) continue;
		total += parsed.cpuTicks;
		members += 1;
	}
	return members === 0 ? undefined : total;
}

function darwinGroupReader({ dlopen, FFIType, ptr }: BunFfi): GroupCpuReader {
	const library = dlopen<{
		proc_listpgrppids: (pgid: number, buffer: number, byteLength: number) => number;
		proc_pid_rusage: (pid: number, flavor: number, buffer: number) => number;
	}>("libSystem.B.dylib", {
		proc_listpgrppids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	});
	const pids = new Int32Array(MAX_GROUP_MEMBERS);
	const usage = new Uint8Array(RUSAGE_BUFFER_BYTES);
	const view = new DataView(usage.buffer);
	return (pgid) => {
		const count = library.symbols.proc_listpgrppids(pgid, ptr(pids), pids.byteLength);
		if (count <= 0) return undefined;
		let total = 0n;
		let members = 0;
		for (const pid of pids.subarray(0, Math.min(count, MAX_GROUP_MEMBERS))) {
			usage.fill(0);
			if (library.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V2, ptr(usage)) !== 0) continue;
			total += view.getBigUint64(RI_USER_TIME_OFFSET, true) + view.getBigUint64(RI_SYSTEM_TIME_OFFSET, true);
			members += 1;
		}
		return members === 0 ? undefined : total;
	};
}
