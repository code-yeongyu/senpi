/**
 * A process identity that no wall-clock step can move (senpi#3152, #6562).
 *
 * The millisecond start instant compared elsewhere is derived on Linux from `/proc/stat` btime, and btime moves with
 * every clock step, so a live process recorded before a step reads as a reused pid after it. A process key is
 * `<boot>:<start>` from values the kernel stores and never rewrites:
 * - Linux: `/proc/sys/kernel/random/boot_id` and the start time in clock ticks since boot (`/proc/<pid>/stat`).
 * - macOS: `kern.bootsessionuuid` and `p_starttime` as `ps -o lstart=` prints it in UTC; that instant is stored at fork,
 *   so a later step does not change it (1 s resolution, compared exactly).
 * - Elsewhere: none; callers fall back to the millisecond rule.
 * Two keys are compared exactly: equal is the same process, different is another one (a reboot changes the boot half).
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

type KeyPlatform = NodeJS.Platform;

let ownBootId: Promise<string | undefined> | undefined;

async function readBootId(platform: KeyPlatform): Promise<string | undefined> {
	if (platform === "linux") return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || undefined;
	if (platform === "darwin")
		return (await run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).trim() || undefined;
	return undefined;
}

/** This machine's boot id: it cannot change while the process lives, so it is read once; a failed read is retried. */
function bootId(platform: KeyPlatform): Promise<string | undefined> {
	if (ownBootId !== undefined) return ownBootId;
	const read = readBootId(platform).catch(() => undefined);
	ownBootId = read.then((id) => {
		if (id === undefined) ownBootId = undefined;
		return id;
	});
	return ownBootId;
}

async function readStart(pid: number, platform: KeyPlatform): Promise<string | undefined> {
	if (platform === "linux") {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
	}
	if (platform === "darwin") {
		const text = (
			await run("ps", ["-o", "lstart=", "-p", String(pid)], { TZ: "UTC", LC_ALL: "C", LANG: "C" })
		).trim();
		return text.length > 0 ? text.replace(/\s+/g, " ") : undefined;
	}
	return undefined;
}

function run(command: string, args: readonly string[], env?: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{ encoding: "utf8", timeout: 5_000, ...(env === undefined ? {} : { env: { ...process.env, ...env } }) },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

export type ProcessKeyReader = (pid: number) => Promise<string | undefined>;

/** The key of the process now wearing `pid` on this machine; `undefined` where it cannot be read. */
export async function readProcessKey(
	pid: number,
	platform: KeyPlatform = process.platform,
): Promise<string | undefined> {
	try {
		const [boot, start] = await Promise.all([bootId(platform), readStart(pid, platform)]);
		return boot !== undefined && start !== undefined ? `${boot}:${start}` : undefined;
	} catch {
		return undefined;
	}
}

let ownKey: Promise<string | undefined> | undefined;

/** This process's own key, read once (a failed read is retried on the next call). */
export function ownProcessKey(): Promise<string | undefined> {
	if (ownKey !== undefined) return ownKey;
	const read = readProcessKey(process.pid);
	ownKey = read.then((key) => {
		if (key === undefined) ownKey = undefined;
		return key;
	});
	return ownKey;
}

/**
 * Whether a recorded key and an observed key name the same process: `undefined` when either is missing, so the caller
 * falls back to its millisecond rule.
 */
export function sameProcessKey(recorded: unknown, observed: string | undefined): boolean | undefined {
	if (typeof recorded !== "string" || recorded.length === 0 || observed === undefined) return undefined;
	return recorded === observed;
}

export async function withOwnProcessKey<T extends object>(record: T): Promise<T & { processKey?: string }> {
	const key = await ownProcessKey();
	return key === undefined ? record : { ...record, processKey: key };
}
