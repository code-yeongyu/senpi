#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";

// Shared by the shipped pipe fallback and Node-only QA scripts (#2999, #4053).
// A recorded parent PID can refer to an older process, not the PID's current holder.
const PROCESS_ROWS = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object {
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

/**
 * The creation time (UTC FILETIME) of one process, or undefined when it cannot be read. Read it while the caller
 * still holds the process handle: Windows does not reuse a PID while a handle to it is open.
 */
export async function windowsProcessCreatedAtAsync(pid, run = execFile) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`;
	const stdout = await new Promise((resolve) => {
		try {
			run(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", query],
				{ encoding: "utf8", windowsHide: true, timeout: 5_000 },
				(error, out) => resolve(error ? "" : String(out)),
			);
		} catch {
			resolve("");
		}
	});
	const text = stdout.trim();
	return /^\d+$/u.test(text) && BigInt(text) > 0n ? BigInt(text) : undefined;
}

/** Signal handlers must not block the event loop while CIM enumerates processes. */
export async function windowsTreeKillArgsAsync(rootPid, run = execFile, selfPid = process.pid, rootCreatedAt) {
	if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === selfPid) return [];
	let result;
	try {
		result = await new Promise((resolve) => {
			run(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", PROCESS_ROWS],
				{
					encoding: "utf8",
					windowsHide: true,
					timeout: 1_000,
					maxBuffer: 16 * 1024 * 1024,
				},
				(error, stdout) => resolve({ error, status: error ? 1 : 0, stdout }),
			);
		});
	} catch (error) {
		result = { error, status: 1 };
	}
	return windowsTreeKillArgs(rootPid, () => result, selfPid, rootCreatedAt);
}

function parseRows(stdout) {
	return stdout.split(/\r?\n/u).flatMap((line) => {
		const [pidText, parentText, createdText, ...name] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		const parentPid = Number(parentText);
		if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || !/^\d+$/u.test(createdText ?? ""))
			return [];
		return [{ pid, parentPid, createdAt: BigInt(createdText), name: name.join(" ") }];
	});
}

/**
 * Explicit PID arguments only; a failed listing permits the owned root, never an unchecked tree.
 *
 * With `rootCreatedAt` (the root's creation time, read while its handle was held) the root is the caller's own
 * handle and is never listed: descendants are anchored on that creation time, so they are still found after the
 * root exits, and a stranger that later took the root's PID, with everything created after it, is skipped.
 */
export function windowsTreeKillArgs(rootPid, run = spawnSync, selfPid = process.pid, rootCreatedAt) {
	const identified = typeof rootCreatedAt === "bigint";
	if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === selfPid) return [];
	const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_ROWS], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 5_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
		return identified ? [] : ["/F", "/PID", String(rootPid)];
	}
	const rows = parseRows(result.stdout);
	if (rows.length === 0) return identified ? [] : ["/F", "/PID", String(rootPid)];
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const rootRow = byPid.get(rootPid);
	if (!identified && !rootRow) return [];
	const strangerCreatedAt = identified && rootRow && rootRow.createdAt !== rootCreatedAt ? rootRow.createdAt : undefined;
	const createdAtOf = (pid) => (identified && pid === rootPid ? rootCreatedAt : byPid.get(pid)?.createdAt);
	const tree = new Set([rootPid]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const row of rows) {
			if (tree.has(row.pid) || !tree.has(row.parentPid)) continue;
			const parentCreatedAt = createdAtOf(row.parentPid);
			if (parentCreatedAt === undefined || parentCreatedAt === 0n || row.createdAt === 0n || row.createdAt < parentCreatedAt)
				continue;
			if (row.parentPid === rootPid && strangerCreatedAt !== undefined && row.createdAt >= strangerCreatedAt) continue;
			tree.add(row.pid);
			grew = true;
		}
	}
	const ancestors = new Set([selfPid]);
	for (let current = byPid.get(selfPid); current !== undefined; ) {
		const parent = byPid.get(current.parentPid);
		if (!parent || ancestors.has(parent.pid) || parent.createdAt > current.createdAt) break;
		ancestors.add(parent.pid);
		current = parent;
	}
	const refused = [...tree].filter(
		(pid) => ancestors.has(pid) || PROTECTED_IMAGES.has(byPid.get(pid)?.name.toLowerCase()),
	);
	if (identified) {
		const descendants = [...tree].filter((pid) => pid !== rootPid);
		return refused.length > 0 || descendants.length === 0 ? [] : ["/F", ...descendants.flatMap((pid) => ["/PID", String(pid)])];
	}
	const pids = refused.length === 0 ? [...tree] : refused.includes(rootPid) ? [] : [rootPid];
	return pids.length === 0 ? [] : ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])];
}
