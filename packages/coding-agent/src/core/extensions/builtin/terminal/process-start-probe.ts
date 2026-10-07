import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const LINUX_CLOCK_TICKS_PER_SECOND = 100;

async function linuxProcessStartMs(pid: number): Promise<number | undefined> {
	const [stat, systemStat] = await Promise.all([
		readFile(`/proc/${pid}/stat`, "utf8"),
		readFile("/proc/stat", "utf8"),
	]);
	const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const startTicks = Number(afterComm[19]);
	const bootSeconds = Number(/^btime (\d+)/m.exec(systemStat)?.[1]);
	if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) return undefined;
	return Math.round((bootSeconds + startTicks / LINUX_CLOCK_TICKS_PER_SECOND) * 1000);
}

function execText(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, [...args], { encoding: "utf8", timeout: 5_000, windowsHide: true }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

async function darwinProcessStartMs(pid: number): Promise<number | undefined> {
	const text = (await execText("ps", ["-o", "lstart=", "-p", String(pid)])).trim();
	if (text.length === 0) return undefined;
	const parsed = new Date(text).getTime();
	return Number.isFinite(parsed) ? parsed : undefined;
}

async function windowsProcessStartMs(pid: number): Promise<number | undefined> {
	const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
	const text = (await execText("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
	const parsed = new Date(text).getTime();
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * When the process currently wearing `pid` started, as the OS reports it; `undefined` when the
 * platform cannot say. Spawns on darwin/win32, so callers keep it off every hot path.
 */
export async function readProcessStartMs(pid: number): Promise<number | undefined> {
	try {
		switch (process.platform) {
			case "linux":
				return await linuxProcessStartMs(pid);
			case "darwin":
				return await darwinProcessStartMs(pid);
			case "win32":
				return await windowsProcessStartMs(pid);
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}
