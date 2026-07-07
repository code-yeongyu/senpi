import { getShellConfig } from "../../../../../utils/shell.ts";
import type { CreatedTerminalSession } from "../manager.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import type { TerminalToolContext } from "./context.ts";

export interface SpawnRequest {
	readonly command: string;
	readonly cols: number;
	readonly rows: number;
	/** Kill deadline in ms for foreground runs; omit for background sessions. */
	readonly timeoutMs?: number;
	/** Working directory override (execute-time `ctx.cwd`); falls back to the tool context cwd. */
	readonly cwd?: string;
}

/**
 * Resolve the configured shell (honoring `SENPI_GIT_BASH_PATH` + shell kind) and spawn a
 * terminal session that runs `command` through it. For stdin-transport shells (legacy WSL
 * bash `-s`) the command is written to the PTY after start; otherwise it rides in argv.
 */
export async function spawnCommandSession(
	ctx: TerminalToolContext,
	request: SpawnRequest,
): Promise<CreatedTerminalSession> {
	const shell = getShellConfig(ctx.shellPath);
	const useStdin = shell.commandTransport === "stdin";
	const args = useStdin ? [...shell.args] : [...shell.args, request.command];

	const created = await ctx.manager.create(shell.shell, {
		command: shell.shell,
		args,
		cwd: request.cwd ?? ctx.cwd,
		env: ctx.getEnv() as Record<string, string | undefined>,
		cols: request.cols,
		rows: request.rows,
		timeoutMs: request.timeoutMs,
	});

	if (useStdin) {
		created.runtime.session.write(`${request.command}\n`);
	}
	return created;
}

/** Snapshot the human-facing exit status of a finished session. */
export function describeExit(runtime: TerminalRuntimeSession): string | null {
	const exit = runtime.exitResult;
	if (!exit) return null;
	if (exit.timedOut) return "timed_out";
	if (exit.cancelled) return "killed";
	if (exit.exitCode === 0) return "completed";
	if (exit.exitCode !== null) return `exited_${exit.exitCode}`;
	if (exit.signal) return `signal_${exit.signal}`;
	return "exited";
}
