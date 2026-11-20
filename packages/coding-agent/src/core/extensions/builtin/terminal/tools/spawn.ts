import { randomBytes } from "node:crypto";
import { getShellConfig } from "../../../../../utils/shell.ts";
import { attestSessionSpawn } from "../../../../session-spawn-attestation.ts";
import type { CreatedTerminalSession } from "../manager.ts";
import type { TerminalExitView, TerminalToolContext } from "./context.ts";

export interface SpawnRequest {
	readonly command: string;
	readonly cols: number;
	readonly rows: number;
	/** Kill deadline in ms for foreground runs; omit for background sessions. */
	readonly timeoutMs?: number;
	/** Working directory override (execute-time `ctx.cwd`); falls back to the tool context cwd. */
	readonly cwd?: string;
	/** Environment overrides merged over `ctx.getEnv()` (foreground non-interactive env). */
	readonly envOverrides?: Readonly<Record<string, string>>;
	/** The session the command runs for; its pid is attested to that session (senpi#6972). */
	readonly sessionId?: string;
}

/** Inside the PTY: no echo while it waits for the go-line, then the real command keeps the PTY's pid and group. */
const PTY_GO_SHIM = 'stty -echo 2>/dev/null; IFS= read -r _go || exit 127; stty echo 2>/dev/null; exec "$0" "$@"';

/**
 * Resolve the configured shell (honoring `SENPI_GIT_BASH_PATH` + shell kind) and spawn a
 * terminal session that runs `command` through it. For stdin-transport shells (legacy WSL
 * bash `-s`) the command is written to the PTY after start; otherwise it rides in argv.
 *
 * A command attested to a session, or launched behind the tool child's barrier, starts gated: the PTY runs the go-line
 * shim, the session-spawn record is written and the barrier admits the launch, and only then is the go-line written
 * (senpi#7120: a command that proves its session the moment it starts must find its record). The go-line is a random
 * token, so its echo, which a native PTY emits when the line arrives before the shim turned echo off, is recognised
 * and dropped from the output (`goLine`).
 */
export async function spawnCommandSession(
	ctx: TerminalToolContext,
	request: SpawnRequest,
): Promise<CreatedTerminalSession> {
	const shell = getShellConfig(ctx.shellPath);
	const useStdin = shell.commandTransport === "stdin";
	const args = useStdin ? [...shell.args] : [...shell.args, request.command];

	// A session-spawn record can be written only where `readKernelProcessIdentity` reads a pid, so only there does the
	// command wait for one.
	const attesting = process.platform === "linux" || process.platform === "darwin";
	const gated = ctx.launchBarrier !== undefined || (request.sessionId !== undefined && attesting);
	const goLine = gated ? `~senpi-go-${randomBytes(8).toString("hex")}` : undefined;
	const created = await ctx.manager.create(shell.shell, {
		command: gated ? "/bin/sh" : shell.shell,
		args: gated ? ["-c", PTY_GO_SHIM, shell.shell, ...args] : args,
		cwd: request.cwd ?? ctx.cwd,
		env: { ...ctx.getEnv(), ...request.envOverrides } as Record<string, string | undefined>,
		cols: request.cols,
		rows: request.rows,
		timeoutMs: request.timeoutMs,
		redactSecretsInOutput: ctx.redactSecretsInOutput,
		...(goLine === undefined ? {} : { goLine }),
	});

	const session = created.runtime.session;
	if (request.sessionId !== undefined && session.pid !== undefined) {
		const attestation = attestSessionSpawn(request.sessionId, session.pid);
		session.onExit(() => void attestation.release());
		await attestation.recorded;
	}
	if (goLine !== undefined) {
		try {
			await ctx.launchBarrier?.admit({
				pid: session.pid,
				onExit: (listener) => session.onExit(() => listener(session.exitResult?.exitCode ?? null)),
			});
		} catch (error) {
			// The command never ran: its gated shim and its registration go with the refusal.
			await ctx.manager.stop(created.id);
			throw error;
		}
		session.write(`${goLine}\n`);
	}
	if (useStdin) {
		session.write(`${request.command}\n`);
	}
	return created;
}

/** Snapshot the human-facing exit status of a finished session. */
export function describeExit(runtime: Pick<TerminalExitView, "exitResult">): string | null {
	const exit = runtime.exitResult;
	if (!exit) return null;
	if (exit.timedOut) return "timed_out";
	if (exit.cancelled) return "killed";
	if (exit.exitCode === 0) return "completed";
	if (exit.exitCode !== null) return `exited_${exit.exitCode}`;
	if (exit.signal) return `signal_${exit.signal}`;
	return "exited";
}
