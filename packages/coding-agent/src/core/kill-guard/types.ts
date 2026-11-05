/** R1 BROAD_PATTERN, R2 PROTECTED_TARGET, R3 ALL_PROCESSES, R4 GROUP, R5 UNKNOWN (senpi#5349). */
export type KillGuardRule = "R1" | "R2" | "R3" | "R4" | "R5";

export interface ProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	/** 0 where the platform does not report it (macOS `ps`). */
	readonly sid: number;
	readonly uid: number;
	readonly comm: string;
	readonly args: string;
}

export type SelectResult =
	| { readonly ok: true; readonly pids: readonly number[] }
	| { readonly ok: false; readonly reason: string };

/** One read of the process table, plus the host's own `pgrep` run with the given arguments and no signal. */
export interface ProcessView {
	readonly rows: readonly ProcessRow[];
	select(args: readonly string[]): SelectResult;
}

/**
 * The process that will issue the signal: a fresh shell in its own session and group (the PTY bash tool, the core
 * bash tool, monitors), the agent itself (an in-thread JS cell), or another process (a py kernel, a JS process kernel).
 */
export type KillGuardVantage =
	| { readonly kind: "fresh-session" }
	| { readonly kind: "agent" }
	| { readonly kind: "process"; readonly pid: number };

/**
 * What reads the command text: `bash` (the bash tool; a later runtime layer wraps its builtin `kill`), `sh` (a
 * POSIX shell no wrapper reaches: `child_process.exec`, py `os.system`), `bun` (`Bun.$`, which has no `kill`
 * builtin), `argv` (a spawn argv, no shell).
 */
export type KillGuardShell = "bash" | "sh" | "bun" | "argv";

export interface KillGuardContext {
	readonly platform: string;
	readonly agentPid: number;
	/** The agent's parent, protected even when the table cannot be read. */
	readonly agentPpid?: number;
	readonly vantage: KillGuardVantage;
	readonly shell: KillGuardShell;
	/** Read once per decision and only when a rule needs it; `undefined` when the table cannot be read. */
	readonly view: () => ProcessView | undefined;
}

export type KillGuardVerdict =
	| { readonly action: "allow" }
	/** A dynamic argument the runtime layer will judge; it runs unjudged until that layer exists. */
	| { readonly action: "defer"; readonly reason: string }
	| { readonly action: "refuse"; readonly rule: KillGuardRule; readonly message: string };

/** `process.kill(target, signal)` / `os.kill` (`group: false`) or `os.killpg(target, signal)` (`group: true`). */
export interface SignalCall {
	readonly target: number;
	readonly group: boolean;
	readonly signal: number | string | undefined;
}
