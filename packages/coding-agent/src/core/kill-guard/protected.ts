import type { KillGuardContext, ProcessRow } from "./types.ts";

/** Protected pid -> why it is protected. */
export type Protected = ReadonlyMap<number, string>;

export function rowOf(rows: readonly ProcessRow[], pid: number): ProcessRow | undefined {
	return rows.find((row) => row.pid === pid);
}

/** Ancestors of `pid` (nearest first), stopping at pid 1 or a loop. */
export function ancestors(rows: readonly ProcessRow[], pid: number): number[] {
	const chain: number[] = [];
	const seen = new Set([pid]);
	let current = rowOf(rows, pid);
	while (current !== undefined && current.ppid > 0 && !seen.has(current.ppid)) {
		chain.push(current.ppid);
		seen.add(current.ppid);
		current = rowOf(rows, current.ppid);
	}
	return chain;
}

/** P without a table: pid 1, the agent and its parent. */
export function minimalProtected(context: KillGuardContext): Protected {
	const set = new Map<number, string>([
		[1, "pid 1"],
		[context.agentPid, "the agent itself"],
	]);
	if (context.agentPpid !== undefined && context.agentPpid > 1) set.set(context.agentPpid, "the agent's parent");
	return set;
}

/** P (DESIGN-12096 v2 §3'): pid 1, the agent, its ancestors, its session leader, and on Linux the user's systemd. */
export function protectedSet(context: KillGuardContext, rows: readonly ProcessRow[]): Protected {
	const set = new Map(minimalProtected(context));
	for (const pid of ancestors(rows, context.agentPid)) if (!set.has(pid)) set.set(pid, "an ancestor of the agent");
	const agent = rowOf(rows, context.agentPid);
	if (agent !== undefined && agent.sid > 0 && !set.has(agent.sid)) set.set(agent.sid, "the agent's session leader");
	if (context.platform === "linux" && agent !== undefined) {
		for (const row of rows) {
			const userManager = row.uid === agent.uid && row.comm === "systemd" && /(^|\s)--user(\s|$)/.test(row.args);
			if (userManager && !set.has(row.pid)) set.set(row.pid, "the user's service manager");
		}
	}
	return set;
}

export function describe(pid: number, rows: readonly ProcessRow[] | undefined, reason: string): string {
	const comm = rows === undefined ? undefined : rowOf(rows, pid)?.comm;
	return `${pid}${comm === undefined ? "" : ` ${comm}`} (${reason})`;
}

/** What BSD `pkill` leaves out by default: its own ancestors, i.e. the caller's chain up to pid 1. */
export function vantageChain(context: KillGuardContext, rows: readonly ProcessRow[]): Set<number> {
	const chain = new Set([context.agentPid, ...ancestors(rows, context.agentPid)]);
	if (context.vantage.kind === "process") {
		chain.add(context.vantage.pid);
		for (const pid of ancestors(rows, context.vantage.pid)) chain.add(pid);
	}
	return chain;
}

/** The caller's own process group; undefined for a fresh shell, whose group holds only the command's processes. */
export function ownGroup(context: KillGuardContext, rows: readonly ProcessRow[]): number | undefined {
	if (context.vantage.kind === "fresh-session") return undefined;
	const pid = context.vantage.kind === "agent" ? context.agentPid : context.vantage.pid;
	return rowOf(rows, pid)?.pgid;
}
