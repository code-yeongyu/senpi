/**
 * A process identity that no wall-clock step can move (senpi#3152, #6562).
 *
 * The millisecond start instant compared elsewhere is derived on Linux from `/proc/stat` btime, and btime moves with
 * every clock step, so a live process recorded before a step reads as a reused pid after it. A process key is
 * `<boot>:<view>:<start>` from values the kernel stores and never rewrites:
 * - Linux: `/proc/sys/kernel/random/boot_id`, the reader's time namespace, and the start time in clock ticks since boot
 *   (`/proc/<pid>/stat`). Since kernel 5.6 those ticks are reported in the READER's time namespace, so two readers in
 *   different time namespaces (a CRIU-restored or `unshare -T` process) compute different keys for one live process.
 *   The view part names the namespace, and keys from different views are not compared (the millisecond rule decides).
 * - macOS: `kern.bootsessionuuid` and `p_starttime` in epoch seconds, parsed from `ps -o lstart=` exactly as the
 *   one-snapshot `ps -axo pid=,lstart=` reader parses it, so both give the same key. The instant is stored at fork, so a
 *   later step does not change it. The resolution is 1 s, which is safe because XNU hands out pids sequentially up
 *   to 99,999 before wrapping: reusing one pid within the same second would take about 100,000 forks in that second.
 * - Elsewhere: none; callers fall back to the millisecond rule.
 * Two keys from the same view are compared exactly: equal is the same process, different is another one (a reboot
 * changes the boot half).
 */
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { lstartUtcMs } from "../../../../utils/process-identity.ts";

type KeyPlatform = NodeJS.Platform;

let ownBootId: Promise<string | undefined> | undefined;

async function readBootId(platform: KeyPlatform): Promise<string | undefined> {
	if (platform === "linux") {
		const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		// No time namespace (kernels before 5.6) is the host's own view.
		const view = await readlink("/proc/self/ns/time").catch(() => "host");
		return boot.length > 0 ? `${boot}:${view.replace(/[^0-9A-Za-z]/g, "")}` : undefined;
	}
	if (platform === "darwin") {
		const boot = (await run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).trim();
		return boot.length > 0 ? `${boot}:host` : undefined;
	}
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
		const startMs = lstartUtcMs(text);
		return startMs === undefined ? undefined : darwinStart(startMs);
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
	const [recordedBoot, recordedView] = recorded.split(":");
	const [observedBoot, observedView] = observed.split(":");
	// Another boot is another process, whatever the view; another view on this boot cannot be compared.
	if (recordedBoot !== observedBoot) return false;
	if (recordedView !== observedView) return undefined;
	return recorded === observed;
}

/**
 * Whether a key was recorded on this machine's current boot: `undefined` when either key is missing, so the caller
 * falls back to the boot instant. Unlike the boot instant, the boot id does not move with a wall-clock step.
 */
export function sameBootByKey(recorded: unknown, own: string | undefined): boolean | undefined {
	if (typeof recorded !== "string" || recorded.length === 0 || own === undefined) return undefined;
	return recorded.split(":")[0] === own.split(":")[0];
}

export async function withOwnProcessKey<T extends object>(record: T): Promise<T & { processKey?: string }> {
	const key = await ownProcessKey();
	return key === undefined ? record : { ...record, processKey: key };
}

const darwinStart = (startMs: number): string => String(Math.floor(startMs / 1000));

/**
 * The key of a process whose start instant a caller already read from one `ps -axo pid=,lstart=` snapshot, so a check
 * over many holders spawns no `ps` per holder. macOS only; `undefined` elsewhere (Linux reads `/proc` without a spawn).
 */
export async function processKeyFromStart(
	startMs: number,
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	if (platform !== "darwin") return undefined;
	const boot = await bootId(platform);
	return boot === undefined ? undefined : `${boot}:${darwinStart(startMs)}`;
}
