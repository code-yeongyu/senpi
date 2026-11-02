import { readdirSync, readFileSync, statSync } from "node:fs";
import type { KillGuardContext, ProcessRow, ProcessView, SelectResult } from "./types.ts";

/** The bound on one table read and on one dry run (DESIGN-12096 §4'). */
export const KILL_GUARD_DEADLINE_MS = 2_000;

/** A synchronous spawn the judge may use; callers pass an original captured before any judging wrapper (A8). */
export type KillGuardSpawnSync = (
	file: string,
	args: readonly string[],
	timeoutMs: number,
) => { readonly status: number | null; readonly stdout: string } | undefined;

type NodeLikeSpawnSync = (
	file: string,
	args: readonly string[],
	options: { timeout: number; encoding: "utf8" },
) => { status: number | null; stdout: string | null; error?: Error };

type BunLikeSpawnSync = (
	argv: string[],
	options: { timeout: number },
) => { exitCode: number | null; stdout: Uint8Array | null | undefined };

export function spawnSyncFromNode(spawnSync: NodeLikeSpawnSync): KillGuardSpawnSync {
	return (file, args, timeoutMs) => {
		const result = spawnSync(file, args, { timeout: timeoutMs, encoding: "utf8" });
		return result.error === undefined ? { status: result.status, stdout: result.stdout ?? "" } : undefined;
	};
}

export function spawnSyncFromBun(spawnSync: BunLikeSpawnSync): KillGuardSpawnSync {
	return (file, args, timeoutMs) => {
		try {
			const result = spawnSync([file, ...args], { timeout: timeoutMs });
			return {
				status: result.exitCode,
				stdout:
					result.stdout === null || result.stdout === undefined ? "" : new TextDecoder().decode(result.stdout),
			};
		} catch {
			return undefined;
		}
	};
}

const PS_ROW = /^\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(.*)$/;

/** `ps -A -o pid=,ppid=,pgid=,sess=,uid=,comm=,args=`; macOS pads `comm` and may put spaces in it, so it is display only. */
export function parsePsRows(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of text.split("\n")) {
		const match = PS_ROW.exec(line);
		if (match === null) continue;
		const rest = match[6] ?? "";
		const first = rest.trim().split(/\s+/)[0] ?? "";
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			pgid: Number(match[3]),
			sid: Number(match[4]),
			uid: Number(match[5]),
			comm: first.split("/").pop() ?? first,
			args: rest.trim(),
		});
	}
	return rows;
}

function readProcRows(deadline: number): ProcessRow[] | undefined {
	const rows: ProcessRow[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		if (Date.now() > deadline) return undefined;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const fields = stat.slice(close + 2).split(" ");
			rows.push({
				pid: Number(entry),
				ppid: Number(fields[1]),
				pgid: Number(fields[2]),
				sid: Number(fields[3]),
				uid: statSync(`/proc/${entry}`).uid,
				comm: stat.slice(stat.indexOf("(") + 1, close),
				args: readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
			});
		} catch {
			// The process exited while the table was read.
		}
	}
	return rows.length > 0 ? rows : undefined;
}

function readPsRows(spawnSync: KillGuardSpawnSync): ProcessRow[] | undefined {
	const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,sess=,uid=,comm=,args="], KILL_GUARD_DEADLINE_MS);
	if (result === undefined || result.status !== 0) return undefined;
	const rows = parsePsRows(result.stdout);
	return rows.length > 0 ? rows : undefined;
}

function parsePids(text: string): number[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^\d+$/.test(line))
		.map(Number);
}

/** The production view: `/proc` on Linux (falling back to `ps`), `ps` elsewhere; `undefined` when neither answers. */
export function createProcessView(platform: string, spawnSync: KillGuardSpawnSync): ProcessView | undefined {
	if (platform === "win32") return undefined;
	let rows: ProcessRow[] | undefined;
	if (platform === "linux") {
		try {
			rows = readProcRows(Date.now() + KILL_GUARD_DEADLINE_MS);
		} catch {
			rows = undefined;
		}
	}
	rows ??= readPsRows(spawnSync);
	if (rows === undefined) return undefined;
	const select = (args: readonly string[]): SelectResult => {
		const result = spawnSync("pgrep", args, KILL_GUARD_DEADLINE_MS);
		if (result === undefined || result.status === null) return { ok: false, reason: "pgrep did not finish" };
		if (result.status === 1) return { ok: true, pids: [] };
		if (result.status !== 0) return { ok: false, reason: `pgrep exited ${result.status}` };
		return { ok: true, pids: parsePids(result.stdout) };
	};
	return { rows, select };
}

export interface KillGuardContextOptions extends Omit<KillGuardContext, "view"> {
	readonly spawnSync: KillGuardSpawnSync;
}

/** A context whose view is read at most once, and only when a rule needs the table. */
export function killGuardContext(options: KillGuardContextOptions): KillGuardContext {
	const { spawnSync, ...context } = options;
	let read = false;
	let view: ProcessView | undefined;
	return {
		...context,
		view: () => {
			if (!read) {
				read = true;
				view = createProcessView(context.platform, spawnSync);
			}
			return view;
		},
	};
}
