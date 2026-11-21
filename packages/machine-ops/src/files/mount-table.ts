import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export interface MountEntry {
	readonly mountPoint: string;
	readonly type: string;
}

const MOUNT_TABLE_TIMEOUT_MS = 2000;

/** `/proc/self/mountinfo`: field 5 is the mount point (octal-escaped), the first field after ` - ` is the type. */
export function parseLinuxMountInfo(text: string): MountEntry[] {
	const entries: MountEntry[] = [];
	for (const line of text.split("\n")) {
		const separator = line.indexOf(" - ");
		if (separator < 0) continue;
		const mountPoint = line.slice(0, separator).split(" ")[4];
		const type = line.slice(separator + 3).split(" ")[0];
		if (mountPoint === undefined || type === undefined || type.length === 0) continue;
		entries.push({
			mountPoint: mountPoint.replace(/\\([0-7]{3})/g, (_, octal: string) =>
				String.fromCharCode(Number.parseInt(octal, 8)),
			),
			type,
		});
	}
	return entries;
}

/** macOS `mount` output: `<source> on <mount point> (<type>, <options>)`; the source may contain spaces, never ` on /`. */
export function parseDarwinMountTable(text: string): MountEntry[] {
	const entries: MountEntry[] = [];
	for (const line of text.split("\n")) {
		const on = line.indexOf(" on /");
		const options = line.lastIndexOf(" (");
		if (on < 0 || options <= on) continue;
		const type = line
			.slice(options + 2)
			.split(/[,)]/)[0]
			?.trim();
		if (!type) continue;
		entries.push({ mountPoint: line.slice(on + 4, options), type });
	}
	return entries;
}

/**
 * The live mount table, read without touching any mounted filesystem: procfs on Linux, and `mount` on macOS, which lists
 * mounts with `getmntinfo(MNT_NOWAIT)` and so never waits on a mount that does not answer. Other platforms, and any
 * failure to read the table, yield an empty table (nothing is classified as an automount trigger).
 */
export async function readMountTable(): Promise<readonly MountEntry[]> {
	if (process.platform === "linux") {
		try {
			return parseLinuxMountInfo(readFileSync("/proc/self/mountinfo", "utf8"));
		} catch {
			return [];
		}
	}
	if (process.platform !== "darwin") return [];
	return new Promise((resolveTable) => {
		execFile("/sbin/mount", [], { timeout: MOUNT_TABLE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			resolveTable(error ? [] : parseDarwinMountTable(String(stdout)));
		});
	});
}
