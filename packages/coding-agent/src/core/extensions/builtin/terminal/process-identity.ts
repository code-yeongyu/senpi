import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { uptime as osUptimeSeconds } from "node:os";
import { workerData } from "node:worker_threads";

export {
	PROCESS_START_TOLERANCE_MS,
	sameProcessStartMs as sameProcessStart,
} from "../../../../utils/process-identity.ts";

/**
 * Two boot instants further apart than this belong to different boots. Where the kernel's boot record is readable two
 * processes read the same value; on the `now - os.uptime()` fallback a laptop's sleep is accounted in uptime, so the
 * only drift left there is whole-second rounding on either side.
 */
export const BOOT_INSTANT_TOLERANCE_MS = 120_000;

const wholeSeconds = (ms: number): number => Math.round(ms / 1000) * 1000;

/**
 * The kernel's own boot instant in epoch seconds: `btime` in `/proc/stat` on Linux, `kern.boottime` on macOS. It
 * is one recorded value, not `now - uptime`, so two reads agree to the second however they straddle an uptime tick
 * (senpi#3152), and a wall-clock step moves it for every process alike. Undefined where neither is readable.
 */
async function readKernelBootEpochSeconds(platform: NodeJS.Platform): Promise<number | undefined> {
	try {
		if (platform === "linux") {
			const match = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"));
			return match ? Number(match[1]) : undefined;
		}
		if (platform === "darwin") {
			const raw = await new Promise<string>((resolve, reject) => {
				execFile(
					"/usr/sbin/sysctl",
					["-n", "kern.boottime"],
					{ encoding: "utf8", timeout: 2_000 },
					(error, stdout) => (error ? reject(error) : resolve(stdout)),
				);
			});
			const match = /sec = (\d+)/.exec(raw);
			return match ? Number(match[1]) : undefined;
		}
	} catch {}
	return undefined;
}

/**
 * The kernel's boot record, read once per process and platform: it cannot change while the machine is up. The read
 * is asynchronous (darwin spawns `sysctl`), so one session never blocks the shared host on it, and every later caller
 * awaits the same promise. A read that found no value is dropped, so the next call reads again; the uptime fallback is
 * computed on every read.
 */
const kernelBootRecords = new Map<NodeJS.Platform, Promise<number | undefined>>();
function kernelBootEpochSeconds(platform: NodeJS.Platform): Promise<number | undefined> {
	const known = kernelBootRecords.get(platform);
	if (known !== undefined) return known;
	const read = readKernelBootEpochSeconds(platform).then((seconds) => {
		if (seconds === undefined) kernelBootRecords.delete(platform);
		return seconds;
	});
	kernelBootRecords.set(platform, read);
	return read;
}

export async function processBootAtMs(
	now: () => number = Date.now,
	platform: NodeJS.Platform = process.platform,
): Promise<number> {
	const bootSeconds = await kernelBootEpochSeconds(platform);
	if (bootSeconds !== undefined) return bootSeconds * 1000;
	return wholeSeconds(now() - osUptimeSeconds() * 1000);
}

const floorToSecond = (ms: number): number => Math.floor(ms / 1000) * 1000;

/**
 * Captured once at load: `process.uptime()` runs on a monotonic clock that stops during a Linux
 * suspend, so recomputing later would drift by every suspend and read our own live lease as reused.
 */
// Bun's worker uptime starts at isolate creation, not process creation. A session
// worker receives the host's start instant so its lease names the same OS process.
const hostIdentity: unknown = workerData;
const OWN_START_AT_LOAD =
	typeof hostIdentity === "object" &&
	hostIdentity !== null &&
	"hostProcessStartedAtMs" in hostIdentity &&
	typeof hostIdentity.hostProcessStartedAtMs === "number" &&
	Number.isFinite(hostIdentity.hostProcessStartedAtMs)
		? hostIdentity.hostProcessStartedAtMs
		: floorToSecond(Date.now() - process.uptime() * 1000);

/** Floored like `ps -o lstart`, which truncates to the second: rounding up could land after now. */
export function ownProcessStartedAtMs(now?: () => number): number {
	return now === undefined ? OWN_START_AT_LOAD : floorToSecond(now() - process.uptime() * 1000);
}

export function sameBoot(bootAtMs: number, otherBootAtMs: number | undefined): boolean {
	if (otherBootAtMs === undefined || !Number.isFinite(otherBootAtMs)) return false;
	return Math.abs(bootAtMs - otherBootAtMs) <= BOOT_INSTANT_TOLERANCE_MS;
}

/**
 * This process's boot instant: the cached kernel record, or with `fresh` a new read of it that replaces the cache. The
 * kernel's recorded boot instant moves with a wall-clock step, so a value cached before a step can be stale.
 */
export type OwnBootReader = (options?: { readonly fresh?: boolean }) => Promise<number>;

export const ownBootAtMs: OwnBootReader = (options) => {
	if (options?.fresh === true) kernelBootRecords.delete(process.platform);
	return processBootAtMs();
};

/**
 * Whether `otherBootAtMs` belongs to this machine's current boot. A 'different boot' verdict on the cached record is
 * checked once more against a fresh read before it stands: after a wall-clock step past the tolerance the cache is
 * stale while a live peer recorded the moved instant, and calling that peer's lock or claim stale would let a second
 * owner in.
 */
export async function sameBootAsOwn(
	otherBootAtMs: number | undefined,
	read: OwnBootReader = ownBootAtMs,
): Promise<boolean> {
	if (otherBootAtMs === undefined || !Number.isFinite(otherBootAtMs)) return false;
	if (sameBoot(await read(), otherBootAtMs)) return true;
	return sameBoot(await read({ fresh: true }), otherBootAtMs);
}

export interface ChildProcessIdentity {
	readonly pid: number;
	readonly processGroupId?: number;
	readonly startedAtMs: number;
	readonly bootAtMs: number;
	readonly argv: readonly string[];
}
