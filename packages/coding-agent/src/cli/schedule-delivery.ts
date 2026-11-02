/**
 * How a due scheduled prompt reaches its session: a `--exec` hook process, or a headless
 * `senpi -p --session` resume guarded against another process having that session open.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveMovedPath } from "../core/extensions/builtin/moved-path-guard/resolve.ts";
import type { ScheduledJob } from "../core/extensions/builtin/schedule/types.ts";
import { liveSessionHolders } from "../core/session-holders.ts";
import { killWindowsProcessTree } from "../utils/shell.ts";

/** What a delivery hook receives on stdin, one JSON object. */
export interface ScheduledPromptEvent {
	readonly type: "scheduled_prompt";
	readonly id: string;
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
	/** The prompt exactly as scheduled. */
	readonly prompt: string;
	/** The prompt with a one-line provenance header; what the default delivery sends. */
	readonly message: string;
	readonly dueAt: number;
	readonly firedAt: number;
	readonly everyMs: number | null;
	/** Occurrence number, starting at 1. */
	readonly fireCount: number;
}

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
/** Called with the delivery process pid as soon as it exists, so the session lock can record it. */
export interface DeliveryContext {
	readonly onSpawn?: (pid: number) => Promise<void>;
}
export type Delivery = (event: ScheduledPromptEvent, context?: DeliveryContext) => Promise<DeliveryResult>;
/** Returns a reason to leave a due job pending for now (for example: its session is open elsewhere). */
export type DeferProbe = (job: ScheduledJob) => Promise<string | undefined>;

// A job written before the desktop moved its data home fires against the moved files; its own file keeps the old paths (senpi#2898).
export function movedJobPaths(job: ScheduledJob): Pick<ScheduledJob, "sessionFile" | "cwd"> {
	return {
		sessionFile: job.sessionFile === null ? null : resolveMovedPath(job.sessionFile),
		cwd: resolveMovedPath(job.cwd),
	};
}

/** Default-delivery guard: do not start a second writer on a session another process has open. */
export async function deferWhileSessionOpen(job: ScheduledJob): Promise<string | undefined> {
	if (job.sessionFile === null || !existsSync(job.sessionFile)) return undefined;
	const holders = await liveSessionHolders(job.sessionFile, job.sessionId);
	if (holders.length === 0) return undefined;
	return `session is open in pid ${holders.map((holder) => holder.pid).join(", ")}; waiting until it closes`;
}

export interface ProcessLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdin?: string;
	/** win32: pass `args` to the process unquoted (a `cmd.exe /s /c "..."` command line). */
	readonly windowsVerbatimArguments?: boolean;
}

const STDERR_TAIL_CHARS = 2000;

/**
 * POSIX gate: the delivery command only starts once the runner writes a line on fd 3, which it does
 * after the process is attached to the session lock. If the runner dies first, fd 3 closes, `read`
 * fails, and nothing is delivered.
 */
export const POSIX_GATE = 'IFS= read -r _ <&3 || exit 75; exec 3<&-; exec "$0" "$@"';

function killTree(pid: number): void {
	if (process.platform === "win32") {
		killWindowsProcessTree(pid); // bounded, absolute taskkill paths, direct-kill fallback
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone: "close" follows.
	}
}

/**
 * Runs one delivery process to completion; exit 0 means delivered. The process is registered via
 * `context.onSpawn` before it may do any work (POSIX: it leads its own process group and waits on a
 * gate); a failed registration kills it and fails the delivery. A timeout kills the whole tree, and
 * the result is only reported once the process has exited.
 */
export function runDeliveryProcess(
	launch: ProcessLaunch,
	timeoutMs: number,
	context: DeliveryContext = {},
): Promise<DeliveryResult> {
	return new Promise((resolve) => {
		const posix = process.platform !== "win32";
		const child = posix
			? spawn("/bin/sh", ["-c", POSIX_GATE, launch.command, ...launch.args], {
					cwd: launch.cwd,
					env: launch.env,
					stdio: ["pipe", "ignore", "pipe", "pipe"],
					detached: true,
				})
			: spawn(launch.command, [...launch.args], {
					cwd: launch.cwd,
					env: launch.env,
					stdio: ["pipe", "ignore", "pipe"],
					windowsHide: true,
					windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
				});
		let stderr = "";
		let failure: string | undefined;
		const timer = setTimeout(() => {
			failure ??= `delivery timed out after ${Math.round(timeoutMs / 1000)}s`;
			if (child.pid !== undefined) killTree(child.pid);
		}, timeoutMs);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
		});
		child.stdin?.on("error", () => {});
		const gate = posix ? child.stdio[3] : null;
		gate?.on("error", () => {});
		child.on("error", (error) => {
			failure ??= error.message;
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (failure !== undefined) resolve({ ok: false, error: failure });
			else if (code === 0) resolve({ ok: true });
			else {
				const status = code === null ? `signal ${signal}` : `exit code ${code}`;
				resolve({ ok: false, error: stderr.trim() ? `${status}: ${stderr.trim()}` : status });
			}
		});
		const pid = child.pid;
		if (pid === undefined) return; // "error" + "close" report the spawn failure
		void Promise.resolve(context.onSpawn?.(pid)).then(
			() => {
				if (gate !== null && gate !== undefined && "end" in gate) gate.end("go\n");
				child.stdin?.end(launch.stdin ?? "");
			},
			(error: unknown) => {
				failure ??= `could not register the delivery: ${error instanceof Error ? error.message : String(error)}`;
				killTree(pid);
			},
		);
	});
}

function eventEnv(event: ScheduledPromptEvent): NodeJS.ProcessEnv {
	return {
		...process.env,
		SENPI_SCHEDULE_ID: event.id,
		SENPI_SCHEDULE_SESSION_ID: event.sessionId,
		SENPI_SCHEDULE_SESSION_FILE: event.sessionFile ?? "",
		SENPI_SCHEDULE_CWD: event.cwd,
	};
}

/**
 * `--exec <command>`: a shell command receives the event as JSON on stdin. It inherits the runner's
 * environment (the operator chose both the command and the environment the runner starts with).
 */
export function execHookDelivery(command: string, timeoutMs: number): Delivery {
	// win32: the command line cmd.exe receives must be the operator's command verbatim inside one pair of
	// quotes (what Node's `shell: true` builds); default argv quoting would escape its quotes as `\"`.
	const shell =
		process.platform === "win32"
			? {
					command: process.env.ComSpec ?? "cmd.exe",
					args: ["/d", "/s", "/c", `"${command}"`],
					windowsVerbatimArguments: true,
				}
			: { command: "/bin/sh", args: ["-c", command] };
	return (event, context) =>
		runDeliveryProcess(
			{ ...shell, env: eventEnv(event), stdin: `${JSON.stringify(event)}\n`, cwd: process.cwd() },
			timeoutMs,
			context,
		);
}

/**
 * Default delivery: resume the scheduling session headlessly (`senpi -p --session <file|id>`) in
 * its working directory, so the fired prompt runs as a new turn of that session.
 */
export function sessionResumeDelivery(
	senpi: { command: string; args: readonly string[] },
	timeoutMs: number,
): Delivery {
	return async (event, context) => {
		if (!existsSync(event.cwd)) return { ok: false, error: `working directory no longer exists: ${event.cwd}` };
		if (event.sessionFile !== null && !existsSync(event.sessionFile)) {
			return { ok: false, error: `session file no longer exists: ${event.sessionFile}` };
		}
		return runDeliveryProcess(
			{
				command: senpi.command,
				args: [...senpi.args, "-p", "--session", event.sessionFile ?? event.sessionId, event.message],
				cwd: event.cwd,
				env: eventEnv(event),
			},
			timeoutMs,
			context,
		);
	};
}
