// senpi#2353: Windows never rewrites a process's ParentProcessId when its parent exits, and it reuses pids
// quickly. On a hosted runner, wininit.exe, csrss.exe and explorer.exe name parents that are long gone,
// and the runner's own Runner.Listener/Runner.Worker descend from wininit.exe. A walk that trusts
// ParentProcessId alone adopts all of them the moment one of Bun's Chrome processes is handed such a
// recycled pid, and the retirement then force-kills the runner (measured: 145 processes, csrss.exe and
// wininit.exe first). A process only counts as a child when it started after the parent it names.

export interface WindowsProcessRow {
	readonly pid: number;
	readonly parentPid: number;
	readonly createdAt: bigint;
	readonly bunChromeFlag: boolean;
	readonly name: string;
}

/**
 * PowerShell that prints one `pid parentPid createdFileTime flag name` line per process, leaving out the
 * listing's own PowerShell (its command line names the flag). The image name comes last because it can
 * contain spaces. A process without a readable creation time prints 0, so it never counts as the child
 * of a process that has one.
 */
export const WINDOWS_PROCESS_ROWS = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object {
$created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
$flag = if ($_.CommandLine -like '*--remote-debugging-pipe*') { 1 } else { 0 }
"{0} {1} {2} {3} {4}" -f $_.ProcessId, $_.ParentProcessId, $created, $flag, $_.Name }`;

export function parseWindowsProcessRows(stdout: string): WindowsProcessRow[] {
	const rows: WindowsProcessRow[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const [pidText, parentText, createdText, flagText, ...nameParts] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		const parentPid = Number(parentText);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || !/^\d+$/u.test(createdText ?? ""))
			continue;
		rows.push({
			pid,
			parentPid,
			createdAt: BigInt(createdText ?? "0"),
			bunChromeFlag: flagText === "1",
			name: nameParts.join(" "),
		});
	}
	return rows;
}

// A browser process by image name. Bun's other children can carry the Chrome flag on their command line (a
// PowerShell listing processes, measured on 26 of 30 runner retirements), so only a browser image roots the tree.
export const BROWSER_IMAGE = /chrom|msedge|brave/iu;

/**
 * Bun's Chrome browsers (direct children of `ownerPid` with a browser image and the flag, started after it) and
 * every process that genuinely descends from them. The walk only ever goes down from those roots.
 */
export function bunChromeTree(rows: readonly WindowsProcessRow[], ownerPid: number): number[] {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const startedAfter = (child: WindowsProcessRow, parentPid: number): boolean => {
		const parent = byPid.get(parentPid);
		return parent !== undefined && child.createdAt >= parent.createdAt;
	};
	const tree = new Set<number>();
	for (const row of rows) {
		if (
			row.parentPid === ownerPid &&
			row.bunChromeFlag &&
			BROWSER_IMAGE.test(row.name) &&
			startedAfter(row, ownerPid)
		)
			tree.add(row.pid);
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const row of rows) {
			if (tree.has(row.pid) || !tree.has(row.parentPid) || !startedAfter(row, row.parentPid)) continue;
			tree.add(row.pid);
			grew = true;
		}
	}
	return [...tree];
}

// Images whose loss takes the machine (or the CI runner) down with it; Chrome never runs as one of them.
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

export interface SkippedProcess {
	readonly pid: number;
	readonly name: string;
	readonly reason: "protected_image" | "ancestor_of_this_process";
}

export interface ChromeKillPlan {
	readonly kill: readonly number[];
	readonly skipped: readonly SkippedProcess[];
}

/**
 * The tree to end. If the walk adopted anything that must never be killed - a protected OS image, or an ancestor
 * of this very process (killing one would end the caller) - the walk is not trusted: nothing is killed and every
 * such process is reported.
 */
export function bunChromeKillPlan(rows: readonly WindowsProcessRow[], ownerPid: number): ChromeKillPlan {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const ancestors = new Set<number>();
	for (let current = byPid.get(ownerPid); current !== undefined && !ancestors.has(current.parentPid); ) {
		const parent = byPid.get(current.parentPid);
		if (parent === undefined || parent.createdAt > current.createdAt) break;
		ancestors.add(parent.pid);
		current = parent;
	}
	const kill: number[] = [];
	const skipped: SkippedProcess[] = [];
	for (const pid of bunChromeTree(rows, ownerPid)) {
		const name = byPid.get(pid)?.name ?? "";
		if (PROTECTED_IMAGES.has(name.toLowerCase())) skipped.push({ pid, name, reason: "protected_image" });
		else if (ancestors.has(pid) || pid === ownerPid) skipped.push({ pid, name, reason: "ancestor_of_this_process" });
		else kill.push(pid);
	}
	// Adopting a process that must never die means the walk itself went wrong, so nothing it found is trusted.
	return skipped.length > 0 ? { kill: [], skipped } : { kill, skipped };
}
