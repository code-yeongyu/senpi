/**
 * Who a pid is, as the kernel reports it: its parent and when it started. Never spawns a child (a `ps` probe per read
 * is the zombie bug omo-desktop#594 fixed) and never throws.
 *
 * - linux: `/proc/<pid>/stat`, fields 4 (ppid), 3 (state) and 22 (start in clock ticks since boot) plus `btime` from
 *   `/proc/stat`;
 * - darwin: `sysctl(KERN_PROC, KERN_PROC_PID, pid)`, the `kinfo_proc` `ps` itself reads, through `bun:ffi`;
 * - anything else, or Node on darwin: `undefined`.
 *
 * `startedAtMs` is derived the same way on every read on one boot, so two reads of one process compare EQUAL; a
 * different process wearing the same pid compares unequal.
 *
 * RUNTIME BOUNDARY: `bun:ffi` is fetched with `process.getBuiltinModule("bun:ffi")` (as `process-footprint.ts` does),
 * which answers `undefined` on Node instead of making this module unloadable.
 */
import { readFile } from "node:fs/promises";

export interface KernelProcessIdentity {
	readonly ppid: number;
	readonly startedAtMs: number;
	/** Exited but not yet reaped: the pid is still taken, but nothing runs under it. */
	readonly zombie: boolean;
}

type BunFfi = typeof import("bun:ffi");
type DarwinReader = (pid: number) => KernelProcessIdentity | undefined;

/** The Linux USER_HZ every supported kernel exports to userspace. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
/** `struct kinfo_proc` (darwin, 64-bit): its size, `p_starttime` (timeval), `p_stat` and `e_ppid`. */
const KINFO_PROC_BYTES = 648;
const KINFO_STARTTIME_SEC_OFFSET = 0;
const KINFO_STARTTIME_USEC_OFFSET = 8;
const KINFO_STAT_OFFSET = 36;
const KINFO_PPID_OFFSET = 560;
const SZOMB = 5;

let linuxBootSeconds: Promise<number | undefined> | undefined;
let darwinReader: DarwinReader | null | undefined;

export async function readKernelProcessIdentity(pid: number): Promise<KernelProcessIdentity | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") return linuxIdentity(pid);
	if (process.platform === "darwin") return loadDarwinReader()?.(pid);
	return undefined;
}

async function linuxIdentity(pid: number): Promise<KernelProcessIdentity | undefined> {
	let stat: string;
	try {
		stat = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	const boot = await (linuxBootSeconds ??= readLinuxBootSeconds());
	// comm (field 2) is parenthesised and may hold spaces, so the fields are counted from its last ")".
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const ppid = Number(fields[1]);
	const startTicks = Number(fields[19]);
	if (boot === undefined || !Number.isInteger(ppid) || !Number.isInteger(startTicks)) return undefined;
	return {
		ppid,
		startedAtMs: boot * 1000 + startTicks * (1000 / LINUX_CLOCK_TICKS_PER_SECOND),
		zombie: fields[0] === "Z",
	};
}

async function readLinuxBootSeconds(): Promise<number | undefined> {
	try {
		const seconds = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]);
		return Number.isInteger(seconds) ? seconds : undefined;
	} catch {
		return undefined;
	}
}

function loadDarwinReader(): DarwinReader | undefined {
	if (darwinReader === undefined) darwinReader = createDarwinReader() ?? null;
	return darwinReader ?? undefined;
}

function createDarwinReader(): DarwinReader | undefined {
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	let read: DarwinReader;
	try {
		read = darwinSysctlReader(ffi);
	} catch {
		return undefined;
	}
	// The offsets are pinned by layout, not by a header: a build whose layout moved fails this self-check and reads
	// nothing, rather than a plausible wrong parent.
	const self = read(process.pid);
	return self !== undefined && self.ppid === process.ppid && !self.zombie ? read : undefined;
}

function darwinSysctlReader({ dlopen, FFIType, ptr }: BunFfi): DarwinReader {
	const library = dlopen("libSystem.B.dylib", {
		sysctl: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
			returns: FFIType.i32,
		},
	});
	const row = new Uint8Array(KINFO_PROC_BYTES);
	const view = new DataView(row.buffer);
	const length = new Uint32Array(2);
	const none = new Uint8Array(1);
	return (pid) => {
		const mib = new Int32Array([1, 14, 1, pid]); // CTL_KERN, KERN_PROC, KERN_PROC_PID
		row.fill(0);
		length[0] = row.byteLength;
		length[1] = 0;
		if (library.symbols.sysctl(ptr(mib), mib.length, ptr(row), ptr(length), ptr(none), 0) !== 0) return undefined;
		// No such process: the kernel answers success with an empty buffer.
		if (length[0] < KINFO_PROC_BYTES) return undefined;
		const seconds = Number(view.getBigInt64(KINFO_STARTTIME_SEC_OFFSET, true));
		const micros = view.getInt32(KINFO_STARTTIME_USEC_OFFSET, true);
		return {
			ppid: view.getInt32(KINFO_PPID_OFFSET, true),
			startedAtMs: seconds * 1000 + Math.floor(micros / 1000),
			zombie: row[KINFO_STAT_OFFSET] === SZOMB,
		};
	};
}
