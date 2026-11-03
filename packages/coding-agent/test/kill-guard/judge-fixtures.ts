import type { KillGuardContext, KillGuardVerdict, ProcessRow } from "../../src/core/kill-guard/index.ts";

export const UID = 501;
export const row = (
	pid: number,
	ppid: number,
	pgid: number,
	sid: number,
	comm: string,
	args = comm,
	uid = UID,
): ProcessRow => ({
	pid,
	ppid,
	pgid,
	sid,
	uid,
	comm,
	args,
});

/** pid 1 -> multiplexer 300 -> login shell 400 (session leader) -> agent 500 (bun) -> kernel 900; plus unrelated jobs. */
export const AGENT = 500;
export const TABLE: readonly ProcessRow[] = [
	row(1, 0, 1, 1, "launchd", "/sbin/launchd", 0),
	row(200, 1, 200, 200, "systemd", "/usr/lib/systemd/systemd --user"),
	row(300, 1, 300, 300, "tmux", "tmux new -s work"),
	row(400, 300, 400, 400, "zsh", "-zsh"),
	row(AGENT, 400, AGENT, 400, "bun", "bun senpi"),
	row(600, 300, 600, 600, "node", "node vite --port 5173"),
	row(700, 1, 700, 700, "redis-server", "redis-server *:6379"),
	row(800, AGENT, 800, 800, "sleep", "sleep 30"),
	row(900, AGENT, 900, 900, "python3", "python3 prelude.py"),
	row(901, 900, 900, 900, "sleep", "sleep 60"),
	row(4000, 300, 4000, 4000, "worker", "omo-worker-1"),
	row(4001, 4000, 4000, 4000, "worker", "omo-worker-2"),
];

export interface Fixture {
	readonly context: KillGuardContext;
	/** Every dry-run selection the judge asked for, as argv after `pgrep`. */
	readonly selections: string[][];
}

export function fixture(
	options: {
		platform?: NodeJS.Platform;
		vantage?: KillGuardContext["vantage"];
		shell?: KillGuardContext["shell"];
		table?: readonly ProcessRow[] | "unreadable";
		select?: (args: readonly string[]) => readonly number[] | "fail";
	} = {},
): Fixture {
	const selections: string[][] = [];
	const table = options.table ?? TABLE;
	const context: KillGuardContext = {
		platform: options.platform ?? "linux",
		agentPid: AGENT,
		agentPpid: 400,
		vantage: options.vantage ?? { kind: "fresh-session" },
		shell: options.shell ?? "bash",
		view: () =>
			table === "unreadable"
				? undefined
				: {
						rows: table,
						select: (args) => {
							selections.push([...args]);
							const picked = options.select?.(args) ?? [];
							return picked === "fail" ? { ok: false, reason: "pgrep exited 2" } : { ok: true, pids: picked };
						},
					},
	};
	return { context, selections };
}

export const rule = (verdict: KillGuardVerdict) => (verdict.action === "refuse" ? verdict.rule : verdict.action);
