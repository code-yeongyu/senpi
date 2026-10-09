import { execFile } from "node:child_process";

// Plain JS (with windows-tree-kill.d.ts) because the worker runtime imports it. `taskkill /T`
// adopts every process whose recorded ParentProcessId equals the root's pid, and Windows never rewrites that
// field when a parent exits and reuses pids (senpi#2999). The tree is computed from one process listing instead: a process
// belongs to it only when it started at or after the parent it names, and each pid is killed by name.

const LISTING_TIMEOUT_MS = 5_000;
const LISTING_MAX_BUFFER = 16 * 1024 * 1024;

const ROWS_SCRIPT = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object {
$created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
"{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $created, $_.Name }`;

const PROTECTED_IMAGES = new Set([
	"system",
	"smss.exe",
	"csrss.exe",
	"wininit.exe",
	"winlogon.exe",
	"services.exe",
	"lsass.exe",
	"lsaiso.exe",
	"svchost.exe",
]);

export function parseWindowsRows(stdout) {
	const rows = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const [pidText, parentText, createdText, ...nameParts] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		const parentPid = Number(parentText);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !/^\d+$/u.test(createdText ?? "")) continue;
		rows.push({ pid, parentPid, createdAt: BigInt(createdText ?? "0"), name: nameParts.join(" ") });
	}
	return rows;
}

/** The root and its genuine descendants; any protected image or ancestor of `selfPid` in it shrinks the kill to the root. */
export function windowsTreeKillPids(rows, rootPid, selfPid) {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	if (!byPid.has(rootPid)) return [];
	const tree = new Set([rootPid]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const row of rows) {
			if (tree.has(row.pid) || !tree.has(row.parentPid)) continue;
			const parent = byPid.get(row.parentPid);
			if (parent === undefined || row.createdAt < parent.createdAt) continue;
			tree.add(row.pid);
			grew = true;
		}
	}
	const ancestors = new Set([selfPid]);
	for (let current = byPid.get(selfPid); current !== undefined; ) {
		const parent = byPid.get(current.parentPid);
		if (parent === undefined || ancestors.has(parent.pid) || parent.createdAt > current.createdAt) break;
		ancestors.add(parent.pid);
		current = parent;
	}
	const refused = [...tree].some((pid) => PROTECTED_IMAGES.has((byPid.get(pid)?.name ?? "").toLowerCase()) || ancestors.has(pid));
	if (!refused) return [...tree];
	const rootRefused = PROTECTED_IMAGES.has(byPid.get(rootPid).name.toLowerCase()) || ancestors.has(rootPid);
	return rootRefused ? [] : [rootPid];
}

/** `taskkill` arguments: the checked tree pid by pid, or `/T` on the root when no listing could be read. */
export function windowsTreeKillArgs(rootPid, rows, selfPid = process.pid) {
	if (rows === undefined) return ["/F", "/T", "/PID", String(rootPid)];
	const pids = windowsTreeKillPids(rows, rootPid, selfPid);
	if (pids.length === 0) return [];
	return ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])];
}

export function listWindowsRows() {
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", ROWS_SCRIPT],
			{ timeout: LISTING_TIMEOUT_MS, maxBuffer: LISTING_MAX_BUFFER, windowsHide: true },
			(error, stdout) => {
				const rows = error ? [] : parseWindowsRows(String(stdout ?? ""));
				resolve(rows.length > 0 ? rows : undefined);
			},
		);
	});
}

/**
 * Kills the checked process tree rooted at `pid`; resolves once taskkill has run (or nothing needed killing).
 * A batch passes one shared `listing` so every tree is planned from the same snapshot.
 */
export async function killWindowsTree(pid, listing = listWindowsRows()) {
	const args = windowsTreeKillArgs(pid, await listing);
	if (args.length === 0) return;
	await new Promise((resolve) => {
		execFile("taskkill", args, { timeout: LISTING_TIMEOUT_MS, windowsHide: true }, () => resolve());
	});
}
