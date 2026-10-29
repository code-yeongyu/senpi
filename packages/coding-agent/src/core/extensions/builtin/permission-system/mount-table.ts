import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type MountEntry = { readonly dev: string; readonly on: string; readonly type: string };
export type MountSnapshot = {
	readonly mounts: MountEntry[];
	/** A rejected line or a missing root entry: the snapshot confirms nothing. */
	readonly degraded: boolean;
	readonly rejected: string[];
	/** Mount points listed more than once where the table's order does not say which mount is visible. */
	readonly ambiguous: string[];
};

const TYPE_TOKEN = /^[a-z0-9_.-]+$/i;

function validMountPoint(on: string): boolean {
	return on.length > 0 && isAbsolute(on) && !on.includes("//") && (on === "/" || !on.endsWith("/"));
}

/**
 * darwin `mount` line `<dev> on <mountpoint> (<type>[, opts...])`, parsed from the RIGHT: the type
 * parenthetical is the last `(...)` at end of line and cannot contain parentheses; the mount point is
 * everything between the FIRST ` on ` and it (device names never contain ` on `; mount points may).
 */
export function parseDarwinMountLine(line: string): MountEntry | undefined {
	const match = /^(.*) \(([^()]*)\)$/.exec(line);
	if (!match) return undefined;
	const type = (match[2] ?? "").split(",")[0]?.trim() ?? "";
	if (!TYPE_TOKEN.test(type)) return undefined;
	const head = match[1] ?? "";
	const onIndex = head.indexOf(" on ");
	if (onIndex <= 0) return undefined;
	const dev = head.slice(0, onIndex);
	const on = head.slice(onIndex + 4);
	if (!dev || !validMountPoint(on)) return undefined;
	return { dev, on, type };
}

function unescapeLinuxMountField(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** linux `/proc/self/mounts` line `<dev> <mountpoint> <type> <opts> <dump> <pass>`, octal-escaped. */
export function parseLinuxMountLine(line: string): MountEntry | undefined {
	const parts = line.split(" ");
	if (parts.length < 3) return undefined;
	const on = unescapeLinuxMountField(parts[1] ?? "");
	const type = parts[2] ?? "";
	const dev = unescapeLinuxMountField(parts[0] ?? "");
	if (!dev || !validMountPoint(on) || !TYPE_TOKEN.test(type)) return undefined;
	return { dev, on, type };
}

/**
 * Every line parsed and validated, or the snapshot is DEGRADED and confirms nothing: a rejected line or
 * a missing root entry degrades it. A mount point listed more than once keeps its LAST line: on linux
 * `/proc/self/mounts` lists mounts in attach order, so that line is the mount visible at the point
 * (stacked mounts are ordinary on systemd hosts). darwin `mount` carries no such ordering contract, so a
 * repeated point is recorded as ambiguous there and the detector confirms nothing beneath it.
 * On linux a mount whose point lies under a mount attached LATER is hidden by it (the table keeps listing
 * it), so it is dropped: paths beneath it are judged by the mount actually visible there.
 */
export function parseMountTable(text: string, platform: string = process.platform): MountSnapshot {
	const byPoint = new Map<string, { entry: MountEntry; lines: number; last: number }>();
	const rejected: string[] = [];
	let order = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const entry = platform === "darwin" ? parseDarwinMountLine(line) : parseLinuxMountLine(line);
		if (entry) byPoint.set(entry.on, { entry, lines: (byPoint.get(entry.on)?.lines ?? 0) + 1, last: order++ });
		else rejected.push(line);
	}
	const listed = [...byPoint.values()];
	const under = (point: string, ancestor: string) =>
		point !== ancestor && point.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
	const points =
		platform === "linux"
			? listed.filter(
					(point) => !listed.some((other) => other.last > point.last && under(point.entry.on, other.entry.on)),
				)
			: listed;
	const mounts = points.map((point) => point.entry).sort((a, b) => b.on.length - a.on.length);
	const ambiguous =
		platform === "linux" ? [] : points.filter((point) => point.lines > 1).map((point) => point.entry.on);
	const degraded = rejected.length > 0 || !mounts.some((mount) => mount.on === "/");
	return { mounts, degraded, rejected, ambiguous };
}

export function readMountTable(platform: string = process.platform): MountSnapshot {
	if (platform === "darwin") {
		const result = spawnSync("mount", [], { encoding: "utf8" });
		if (result.error || result.status !== 0)
			return { mounts: [], degraded: true, rejected: ["mount command failed"], ambiguous: [] };
		return parseMountTable(result.stdout, "darwin");
	}
	if (existsSync("/proc/self/mounts")) return parseMountTable(readFileSync("/proc/self/mounts", "utf8"), "linux");
	return { mounts: [], degraded: true, rejected: ["no mount table source"], ambiguous: [] };
}
