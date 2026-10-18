import { spawnSync } from "node:child_process";

// senpi#2999 (follow-up of #2353): `taskkill /T` adopts every process whose recorded ParentProcessId
// equals the root's pid. Windows never rewrites that field when a parent exits and reuses pids, so an
// older, unrelated process that names a long-dead parent whose pid the root now holds is killed too.
// The tree is computed here instead: a process belongs to it only when it started at or after the
// parent it names, and the kill names each pid explicitly (no /T).

export interface WindowsProcessRow {
	readonly pid: number;
	readonly parentPid: number;
	readonly createdAt: bigint;
	readonly name: string;
}

/** One `pid parentPid createdFileTime name` line per process; the listing's own PowerShell is left out. */
export const WINDOWS_PROCESS_TREE_ROWS = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object {
$created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
"{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, $created, $_.Name }`;

export function parseWindowsProcessTreeRows(stdout: string): WindowsProcessRow[] {
	const rows: WindowsProcessRow[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const [pidText, parentText, createdText, ...nameParts] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		const parentPid = Number(parentText);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !/^\d+$/u.test(createdText ?? ""))
			continue;
		rows.push({ pid, parentPid, createdAt: BigInt(createdText ?? "0"), name: nameParts.join(" ") });
	}
	return rows;
}

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

export interface WindowsTreeKillPlan {
	/** Pids to end with one `taskkill /F /PID a /PID b ...` (never /T). */
	readonly kill: readonly number[];
	/** Processes the walk adopted that must never be killed; any entry here means only the root is killed. */
	readonly refused: readonly { readonly pid: number; readonly name: string }[];
}

/**
 * The root and every process that genuinely descends from it. A protected OS image or an ancestor of
 * `selfPid` in that set means the walk went wrong, so only the root itself is killed (and nothing when
 * the root is one of them).
 */
export function windowsTreeKillPlan(
	rows: readonly WindowsProcessRow[],
	rootPid: number,
	selfPid: number,
): WindowsTreeKillPlan {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const root = byPid.get(rootPid);
	if (root === undefined) return { kill: [], refused: [] };
	const tree = new Set<number>([rootPid]);
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
	const ancestors = new Set<number>([selfPid]);
	for (let current = byPid.get(selfPid); current !== undefined; ) {
		const parent = byPid.get(current.parentPid);
		if (parent === undefined || ancestors.has(parent.pid) || parent.createdAt > current.createdAt) break;
		ancestors.add(parent.pid);
		current = parent;
	}
	const refused = [...tree]
		.map((pid) => ({ pid, name: byPid.get(pid)?.name ?? "" }))
		.filter((entry) => PROTECTED_IMAGES.has(entry.name.toLowerCase()) || ancestors.has(entry.pid));
	if (refused.length === 0) return { kill: [...tree], refused };
	const rootRefused = refused.some((entry) => entry.pid === rootPid);
	return { kill: rootRefused ? [] : [rootPid], refused };
}

/** Bounded synchronous CIM listing; undefined when it cannot run or does not finish in time. */
export function listWindowsProcessRowsSync(timeoutMs: number): WindowsProcessRow[] | undefined {
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TREE_ROWS],
		{
			encoding: "utf8",
			windowsHide: true,
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return undefined;
	const rows = parseWindowsProcessTreeRows(result.stdout);
	return rows.length > 0 ? rows : undefined;
}

/**
 * `taskkill` arguments for one tree kill. With a process listing, the checked tree is named pid by pid
 * (never `/T`). Without one, `/T` is kept: leaving every descendant running is the worse failure, and the
 * recycled-pid hazard needs a pid wraparound that a missing listing does not make more likely.
 */
export function windowsTreeKillArgs(
	rootPid: number,
	rows: readonly WindowsProcessRow[] | undefined,
	selfPid = process.pid,
): string[] {
	if (rows === undefined) return ["/F", "/T", "/PID", String(rootPid)];
	const pids = windowsTreeKillPlan(rows, rootPid, selfPid).kill;
	if (pids.length === 0) return [];
	return ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])];
}
