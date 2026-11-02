import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BunFfi, loadBunFfi } from "../src/kernels/shared/bun-ffi.ts";
import { parseProcStat } from "../src/kernels/shared/process-group-cpu.ts";
import { BenchAccountingError } from "./bench-accounting.ts";

type CpuReader = (pid: number) => number;
let nativeReader: CpuReader | null | undefined;

/** A single live interpreter's cumulative user+system microseconds, read by the host. */
export function readInterpreterCpuUs(pid: number, python: string): number {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new BenchAccountingError("invalid interpreter PID");
	if (nativeReader === undefined) nativeReader = createNativeReader() ?? null;
	const cpuUs = nativeReader
		? nativeReader(pid)
		: Number(
				execFileSync(python, [fileURLToPath(new URL("./bench-process-cpu.py", import.meta.url)), String(pid)], {
					encoding: "utf8",
					timeout: 2_000,
				}).trim(),
			);
	if (!Number.isFinite(cpuUs) || cpuUs < 0) throw new BenchAccountingError(`invalid CPU receipt for ${pid}`);
	return cpuUs;
}

function createNativeReader(): CpuReader | undefined {
	const ffi = loadBunFfi();
	if (!ffi) return undefined;
	if (process.platform === "darwin") return darwinReader(ffi);
	if (process.platform === "linux") return linuxReader(ffi);
	throw new BenchAccountingError("live process CPU accounting requires POSIX");
}

function darwinReader({ dlopen, FFIType, ptr }: BunFfi): CpuReader {
	const library = dlopen<{
		proc_pid_rusage: (pid: number, flavor: number, buffer: number) => number;
		mach_timebase_info: (buffer: number) => number;
	}>("libSystem.B.dylib", {
		proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
		mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const timebase = new Uint32Array(2);
	if (library.symbols.mach_timebase_info(ptr(timebase)) !== 0)
		throw new BenchAccountingError("native CPU timebase unavailable");
	const numerator = timebase[0];
	const denominator = timebase[1];
	if (!numerator || !denominator) throw new BenchAccountingError("invalid native CPU timebase");
	const usage = new Uint8Array(256);
	const view = new DataView(usage.buffer);
	return (pid) => {
		usage.fill(0);
		if (library.symbols.proc_pid_rusage(pid, 2, ptr(usage)) !== 0)
			throw new BenchAccountingError(`live CPU unavailable for ${pid}`);
		// rusage_info_v2: UUID[16], then user/system Mach absolute-time units.
		const ticks = view.getBigUint64(16, true) + view.getBigUint64(24, true);
		return (Number(ticks) * numerator) / denominator / 1_000;
	};
}

function linuxReader({ dlopen, FFIType }: BunFfi): CpuReader {
	const library = dlopen<{ sysconf: (name: number) => number | bigint }>("libc.so.6", {
		sysconf: { args: [FFIType.i32], returns: FFIType.i64 },
	});
	const ticksPerSecond = Number(library.symbols.sysconf(2)); // Linux _SC_CLK_TCK.
	if (!(ticksPerSecond > 0)) throw new BenchAccountingError("process CPU clock frequency unavailable");
	return (pid) => {
		const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
		if (!stat) throw new BenchAccountingError(`invalid process CPU stat for ${pid}`);
		return (Number(stat.cpuTicks) * 1_000_000) / ticksPerSecond;
	};
}
