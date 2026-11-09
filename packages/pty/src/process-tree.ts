import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import type { TerminalSessionHandle, TerminalSessionSignal } from "./session-types.ts";

/** How often a stop path re-checks whether a process group still has members; no event reports it. */
const GROUP_POLL_MS = 25;
/** How often an armed leftover record checks on its own whether its group is gone (see LeftoverProcessGroup). */
const LEFTOVER_PROBE_MS = 1000;

/**
 * Terminate the child, preferring its whole process group on POSIX. The
 * detached child is its own group leader and grandchildren inherit the stdio
 * pipes, so leaving them alive keeps 'close' from ever firing (the POSIX twin
 * of the Windows taskkill /T branch below). Every path that stops a child must
 * go through here: when the group signal is unavailable (Windows, no pid) or
 * the group is already gone, it still falls back to a direct kill, so the
 * child is never left running.
 */
export function terminateChildTree(
	child: Pick<ChildProcess, "pid" | "kill">,
	signal: NodeJS.Signals,
): "group" | "direct" | "none" {
	const pid = child.pid;
	// A child that never started has no pid; on Node < 24.22 / 26.10 its kill() signals our own process group.
	if (pid === undefined) return "none";
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			return "group";
		} catch {
			// Group already gone — fall through to the direct kill.
		}
	}
	child.kill(signal);
	return "direct";
}

/**
 * On Windows child.kill() TerminateProcess-es only the direct child, leaving
 * grandchildren (e.g. `sleep` under `bash.exe -c`) alive and holding the stdout
 * pipe open — so 'close' never fires and waitExit() hangs teardown. taskkill /T /F
 * terminates the whole tree so the pipe EOFs and the session settles. Returns the note.
 */
export function terminateWindowsTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): string {
	try {
		const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		killer.once("error", () => {
			terminateChildTree(child, signal);
		});
		return `Terminated child_process pipe fallback process tree (pid ${pid}).`;
	} catch {
		terminateChildTree(child, signal);
		return `Sent ${signal} to child_process pipe fallback session.`;
	}
}

/** Whether process group `pgid` has a member. Only ESRCH means empty: EPERM still names a live group. */
function processGroupHasMembers(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

/**
 * The process group of a session that settled while processes the command started were still in it
 * (`cmd &`, a daemon, the children of a shell killed from outside). Settling does not kill them
 * (senpi#6201); this keeps them reachable from kill(), terminate() and registry teardown. It is keyed on
 * the group and remembered only when the group still had members at the settle.
 *
 * The id must never be signalled once it could name someone else's group. POSIX does not hand an id out as
 * a pid while a process group with that id exists, so it can only be reused after the group empties. An
 * armed record therefore probes on its own every `LEFTOVER_PROBE_MS` (unref'd: it never keeps the process
 * alive) and disarms for good the first time the group is seen empty, from the probe or from any stop
 * path, which also clears the probe. A stranger could only be hit if the pid space wrapped (99999 on macOS,
 * pid_max on Linux) and handed out exactly this id as a new group leader within one probe interval after
 * the last member exited: not a realistic window.
 */
export class LeftoverProcessGroup {
	#pgid: number | undefined;
	#probe: ReturnType<typeof setInterval> | undefined;
	readonly #hasMembers: (pgid: number) => boolean;
	readonly #probeIntervalMs: number;

	constructor(options: { readonly hasMembers?: (pgid: number) => boolean; readonly probeIntervalMs?: number } = {}) {
		this.#hasMembers = options.hasMembers ?? processGroupHasMembers;
		this.#probeIntervalMs = options.probeIntervalMs ?? LEFTOVER_PROBE_MS;
	}

	/** The group still remembered, without probing it; undefined once disarmed. */
	get armedGroup(): number | undefined {
		return this.#pgid;
	}

	/** Called once at the settle. */
	arm(pgid: number | undefined): void {
		if (pgid === undefined || !this.#hasMembers(pgid)) return;
		this.#pgid = pgid;
		this.#probe = setInterval(() => this.alive(), this.#probeIntervalMs);
		this.#probe.unref?.();
	}

	alive(): boolean {
		if (this.#pgid === undefined) return false;
		if (this.#hasMembers(this.#pgid)) return true;
		this.#disarm();
		return false;
	}

	#disarm(): void {
		this.#pgid = undefined;
		clearInterval(this.#probe);
		this.#probe = undefined;
	}

	/** Signal the group while it has members; the pgid signalled, or undefined when nothing is left. */
	signal(signal: NodeJS.Signals): number | undefined {
		const pgid = this.#pgid;
		if (pgid === undefined || !this.alive()) return undefined;
		try {
			process.kill(-pgid, signal);
			return pgid;
		} catch {
			// ESRCH: the last member went between the probe and the signal.
			return undefined;
		}
	}

	/** Wait up to `graceMs` for the group to empty; true once nothing is left. */
	async waitGone(graceMs: number): Promise<boolean> {
		const deadline = Date.now() + graceMs;
		while (this.alive()) {
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
		}
		return true;
	}
}

/**
 * TERM, a bounded grace, then KILL for whatever a settled session left in its process group: the same
 * escalation a live session gets. A backend without a leftover group (native, Bun) makes this a no-op.
 */
export async function stopLeftoverGroup(
	handle: TerminalSessionHandle,
	signal: TerminalSessionSignal,
	graceMs: number,
	forcedGraceMs: number,
): Promise<void> {
	if (handle.leftoverAlive?.() !== true) return;
	handle.kill(signal);
	if ((await handle.waitLeftoverGone?.(graceMs)) !== false) return;
	handle.kill("SIGKILL");
	await handle.waitLeftoverGone?.(forcedGraceMs);
}
