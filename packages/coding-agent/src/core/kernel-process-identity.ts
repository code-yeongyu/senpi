/**
 * Who a pid is, as the kernel reports it: its parent and when it started. Never throws.
 *
 * - linux: `/proc/<pid>/stat`, fields 4 (ppid), 3 (state) and 22 (start in clock ticks since boot), kept boot-relative
 *   so a stepped wall clock (an NTP step, a VM resume) never changes it, plus `/proc/sys/kernel/random/boot_id`;
 * - darwin on Bun: `sysctl(KERN_PROC, KERN_PROC_PID, pid)`, the `kinfo_proc` `ps` itself reads, through `bun:ffi`,
 *   without spawning (a `ps` probe from Bun is the zombie bug omo-desktop#594 fixed);
 * - darwin on Node: `ps -o ppid=,stat=,lstart=` in UTC (Node reaps its children; UTC has no repeated hour, so this
 *   agrees with the kernel's stamp all year);
 * - anything else: `undefined`.
 *
 * `startedAtMs` is derived the same way on every read on one boot, so two reads of one process compare EQUAL; a
 * different process wearing the same pid compares unequal. It is milliseconds since boot on linux, scoped by `bootId`,
 * and the kernel's fixed wall-clock start stamp in whole seconds on darwin (the precision `ps` reports, so both darwin
 * readers agree; darwin has no `bootId`).
 *
 * RUNTIME BOUNDARY: `bun:ffi` is fetched with `process.getBuiltinModule("bun:ffi")` (as `process-footprint.ts` does),
 * which answers `undefined` on Node instead of making this module unloadable.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface KernelProcessIdentity {
	readonly ppid: number;
	readonly startedAtMs: number;
	/** The boot this start time is relative to (linux); undefined where the start time is a wall-clock stamp. */
	readonly bootId: string | undefined;
	/** Exited but not yet reaped: the pid is still taken, but nothing runs under it. */
	readonly zombie: boolean;
}

type BunFfi = typeof import("bun:ffi");
type SysctlReader = (pid: number) => KernelProcessIdentity | undefined;
type DarwinReader = (pid: number) => KernelProcessIdentity | undefined | Promise<KernelProcessIdentity | undefined>;

/** The Linux USER_HZ every supported kernel exports to userspace. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
/** `struct kinfo_proc` (darwin, 64-bit): its size, `p_starttime.tv_sec`, `p_stat` and `e_ppid`. */
const KINFO_PROC_BYTES = 648;
const KINFO_STARTTIME_SEC_OFFSET = 0;
const KINFO_STAT_OFFSET = 36;
const KINFO_PPID_OFFSET = 560;
const SZOMB = 5;

let linuxBootId: Promise<string | undefined> | undefined;
let darwinReader: DarwinReader | undefined;

export async function readKernelProcessIdentity(pid: number): Promise<KernelProcessIdentity | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") return linuxIdentity(pid);
	if (process.platform === "darwin") return await loadDarwinReader()(pid);
	return undefined;
}

async function linuxIdentity(pid: number): Promise<KernelProcessIdentity | undefined> {
	let stat: string;
	try {
		stat = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	const bootId = await (linuxBootId ??= readLinuxBootId());
	// comm (field 2) is parenthesised and may hold spaces, so the fields are counted from its last ")".
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const ppid = Number(fields[1]);
	const startTicks = Number(fields[19]);
	if (bootId === undefined || !Number.isInteger(ppid) || !Number.isInteger(startTicks)) return undefined;
	return {
		ppid,
		startedAtMs: startTicks * (1000 / LINUX_CLOCK_TICKS_PER_SECOND),
		bootId,
		zombie: fields[0] === "Z",
	};
}

async function readLinuxBootId(): Promise<string | undefined> {
	try {
		const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		return bootId.length > 0 ? bootId : undefined;
	} catch {
		return undefined;
	}
}

function loadDarwinReader(): DarwinReader {
	if (darwinReader === undefined) {
		const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
		darwinReader = ffi === undefined ? darwinPsIdentity : (createDarwinReader(ffi) ?? (() => undefined));
	}
	return darwinReader;
}

function darwinPsIdentity(pid: number): Promise<KernelProcessIdentity | undefined> {
	return new Promise((resolve) => {
		execFile(
			"ps",
			["-o", "ppid=,stat=,lstart=", "-p", String(pid)],
			{ encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } },
			(error, stdout) => resolve(error === null ? parseDarwinPsIdentity(stdout) : undefined),
		);
	});
}

/** One `ps -o ppid=,stat=,lstart=` line printed under `TZ=UTC`; the start time is read as UTC whatever the reader's zone. */
export function parseDarwinPsIdentity(stdout: string): KernelProcessIdentity | undefined {
	const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(stdout);
	const startedAtMs = match?.[3] === undefined ? Number.NaN : Date.parse(`${match[3]} UTC`);
	if (match === null || !Number.isFinite(startedAtMs)) return undefined;
	return {
		ppid: Number(match[1]),
		startedAtMs,
		bootId: undefined,
		zombie: match[2]?.startsWith("Z") === true,
	};
}

function createDarwinReader(ffi: BunFfi): SysctlReader | undefined {
	let read: SysctlReader;
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

function darwinSysctlReader({ dlopen, FFIType, ptr }: BunFfi): SysctlReader {
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
		return {
			ppid: view.getInt32(KINFO_PPID_OFFSET, true),
			startedAtMs: Number(view.getBigInt64(KINFO_STARTTIME_SEC_OFFSET, true)) * 1000,
			bootId: undefined,
			zombie: row[KINFO_STAT_OFFSET] === SZOMB,
		};
	};
}
