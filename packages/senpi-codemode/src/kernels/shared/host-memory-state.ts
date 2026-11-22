import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { formatBytes } from "./kernel-memory.ts";

const READ_TIMEOUT_MS = 1_000;
const MIB = 1024 * 1024;
const KIB = 1024;

/** kern.memorystatus_vm_pressure_level: the kernel's own verdict, the one jetsam acts on. */
const DARWIN_PRESSURE_LEVELS: Readonly<Record<string, string>> = { "1": "normal", "2": "warning", "4": "critical" };

export type HostMemoryReader = () => Promise<string | undefined>;

/**
 * The host's memory state in a few words, for a notice about a kernel the system may have killed:
 * macOS memory pressure and swap in use, Linux available memory and swap in use. `undefined` when the
 * platform has no reading or it could not be taken in time; the notice then simply says less.
 */
export const readHostMemoryState: HostMemoryReader = async () => {
	try {
		if (process.platform === "darwin") return describeDarwin(await sysctl());
		if (process.platform === "linux") return describeLinux(await readFile("/proc/meminfo", "utf8"));
		return undefined;
	} catch {
		return undefined;
	}
};

function sysctl(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"sysctl",
			["-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage"],
			{ encoding: "utf8", timeout: READ_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

export function describeDarwin(output: string): string | undefined {
	const [levelLine = "", swapLine = ""] = output.trim().split("\n");
	const parts: string[] = [];
	const level = DARWIN_PRESSURE_LEVELS[levelLine.trim()];
	if (level !== undefined) parts.push(`system memory pressure ${level}`);
	const used = /used = ([\d.]+)M/u.exec(swapLine)?.[1];
	if (used !== undefined) parts.push(`swap used ${formatBytes(Number(used) * MIB)}`);
	return parts.length === 0 ? undefined : parts.join(", ");
}

export function describeLinux(meminfo: string): string | undefined {
	const kib = (key: string): number | undefined => {
		const value = new RegExp(`^${key}:\\s+(\\d+) kB$`, "mu").exec(meminfo)?.[1];
		return value === undefined ? undefined : Number(value) * KIB;
	};
	const available = kib("MemAvailable");
	const total = kib("MemTotal");
	const swapTotal = kib("SwapTotal");
	const swapFree = kib("SwapFree");
	const parts: string[] = [];
	if (available !== undefined && total !== undefined)
		parts.push(`${formatBytes(available)} of ${formatBytes(total)} memory available`);
	if (swapTotal !== undefined && swapFree !== undefined && swapTotal > 0)
		parts.push(`swap used ${formatBytes(swapTotal - swapFree)}`);
	return parts.length === 0 ? undefined : parts.join(", ");
}
