/**
 * Whether the supervisor's host child pid still names THAT child (senpi#7525). A missed exit event proves nothing
 * about the pid: the runtime may already have reaped the child, and the number may name another process. So every
 * signal the supervisor sends its child, and every verdict that the child is gone, rests on one fresh observation:
 * - `ours`: the pid's parent is this supervisor, it is not an exited (zombie) process, and its start matches the
 *   baseline (Linux `/proc` start ticks; elsewhere `ps lstart`);
 * - `gone`: no such pid, a zombie, another parent, or another start - the child has exited;
 * - `unknown`: the observation itself failed - never a reason to signal, never death.
 * The baseline is this object's own: read at spawn, never taken from a metadata file whose write can fail. A start
 * not read yet is read live by the next check: a live, non-zombie process whose parent is this supervisor is its
 * child, so that live read is the baseline from then on and the check answers `ours`. An ordinary stop of a live
 * child therefore always reaches it (senpi#7525 delta review). Node has no pidfd, so parent plus start time is the
 * identity; the probe is bounded and spawns nothing on Linux.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, type Writable } from "node:stream";
import { processIsLive, processStartTimeMs, sameProcessStartMs } from "../../utils/process-identity.ts";
import { readProcessStartTicks } from "../../utils/process-start-identity.ts";
import { childLivenessRecheckMs } from "./host-stop-intent.ts";
import { errorMessage, supervisorLog } from "./host-supervisor-log.ts";

export type ChildPresence = "ours" | "gone" | "unknown";

/** What every signal to the host child, and every verdict that it is gone, is decided by. */
export interface ChildPresenceProbe {
	readonly pid: number | undefined;
	presence(): Promise<ChildPresence>;
}

/** Bound on one `ps` snapshot: an unanswered probe is `unknown`, never a wait the watchdog parks on. */
const PS_PROBE_TIMEOUT_MS = 2_000;

export class HostChildIdentity implements ChildPresenceProbe {
	readonly pid: number | undefined;
	private readonly platform: NodeJS.Platform;
	private ticks: string | undefined;
	private startTime: string | undefined;

	/** Constructed right after spawn, while the pid can only be this child: it is not reaped before the loop turns. */
	constructor(pid: number | undefined, platform: NodeJS.Platform = process.platform) {
		this.pid = pid;
		this.platform = platform;
		if (pid === undefined) return;
		if (platform === "linux") this.ticks = readProcessStartTicks(pid);
		// The ps snapshot at spawn; a failed one leaves the baseline to the next check's live read.
		else if (platform !== "win32") void this.presence();
	}

	async presence(): Promise<ChildPresence> {
		const { pid } = this;
		if (pid === undefined) return "gone";
		if (this.platform === "win32") return processIsLive(pid) ? "ours" : "gone";
		if (this.platform === "linux") return this.procPresence(pid);
		return this.psPresence(pid);
	}

	private procPresence(pid: number): ChildPresence {
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch (cause) {
			return cause instanceof Error && "code" in cause && cause.code === "ENOENT" ? "gone" : "unknown";
		}
		// The command name (field 2) may hold spaces and parentheses; fields resume after its last ")".
		const [state, ppid, ...rest] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (Number(ppid) !== process.pid || state === "Z" || state === "X") return "gone";
		const ticks = rest[17];
		if (ticks === undefined) return "unknown";
		this.ticks ??= ticks;
		return ticks === this.ticks ? "ours" : "gone";
	}

	private psPresence(pid: number): Promise<ChildPresence> {
		return new Promise((resolve) => {
			execFile(
				"ps",
				["-o", "ppid=,stat=,lstart=", "-p", String(pid)],
				{ timeout: PS_PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } },
				(error, stdout) => {
					// ps exits 1 for a pid it does not know; any other failure answers nothing.
					if (error) return resolve("code" in error && error.code === 1 ? "gone" : "unknown");
					const [ppid, state, ...start] = stdout.trim().split(/\s+/);
					if (Number(ppid) !== process.pid || state === undefined || state.startsWith("Z")) return resolve("gone");
					const observed = `${start.join(" ")} UTC`;
					const observedMs = processStartTimeMs(observed);
					if (observedMs === undefined) return resolve("unknown");
					this.startTime ??= observed;
					const baselineMs = processStartTimeMs(this.startTime);
					resolve(baselineMs !== undefined && sameProcessStartMs(baselineMs, observedMs) ? "ours" : "gone");
				},
			).once("error", () => resolve("unknown"));
		});
	}
}

/** Signals only a pid proven to be this live child; anything else is answered by the observation that refused it. */
export async function signalProvenChild(
	child: ChildProcess,
	probe: ChildPresenceProbe,
	signal: NodeJS.Signals,
): Promise<ChildPresence> {
	if (childExited(child)) return "gone";
	const presence = await probe.presence();
	if (childExited(child)) return "gone";
	if (presence !== "ours" || probe.pid === undefined) {
		supervisorLog(
			`host child pid ${probe.pid ?? "unknown"} is not provably this child (${presence}); not sending ${signal}`,
		);
		return presence;
	}
	try {
		process.kill(probe.pid, signal);
	} catch (cause) {
		supervisorLog(`could not send ${signal} to host child pid ${probe.pid}: ${errorMessage(cause)}`);
	}
	return "ours";
}

function childExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * POSIX: the host child gone although its exit was never observed (oh-my-openagent#14725) - a child nobody reaped, a
 * zombie under a supervisor that ran for days. Nothing else ends that generation: the idle ticker and the owner check
 * stand down while draining, and the supervisor keeps the public socket, accepting every client and fresh bind and
 * serving none. So the child's identity is re-checked every `childLivenessRecheckMs()`, and at once when the
 * lifetime slot reports EOF. That EOF only prompts a check: a launcher can drop the slot from a healthy host, and a
 * descendant can keep it open past a dead one. Two `gone` observations in a row, with no exit observed and no
 * shutdown begun after either, run `onGone`; an exit that lands in between keeps its own verdict.
 */
export function watchChildLiveness(options: {
	readonly child: ChildProcess;
	readonly identity: ChildPresenceProbe;
	readonly lifetime: Readable | Writable | null | undefined;
	readonly settled: () => boolean;
	readonly onGone: () => void;
}): () => void {
	const { child, identity, lifetime, settled, onGone } = options;
	if (process.platform === "win32") return () => {};
	const recheckMs = childLivenessRecheckMs();
	const ended = () => settled() || childExited(child);
	let stopped = false;
	let checking = false;
	let suspect = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = (): void => {
		clearTimeout(timer);
		if (stopped || ended()) return;
		timer = setTimeout(() => void check(false), recheckMs);
		timer.unref?.();
	};
	const check = async (lifetimeClosed: boolean): Promise<void> => {
		if (stopped || checking || ended()) return;
		checking = true;
		try {
			const presence = await identity.presence();
			if (stopped || ended()) return;
			if (presence !== "gone") {
				suspect = false;
				if (lifetimeClosed)
					supervisorLog(
						`host child pid ${identity.pid ?? "unknown"} closed its lifetime pipe but is still running; re-checking it every ${recheckMs}ms`,
					);
				return;
			}
			if (!suspect) {
				suspect = true;
				supervisorLog(
					`host child pid ${identity.pid ?? "unknown"} is gone but its exit was not observed; confirming`,
				);
				return;
			}
			stopped = true;
			onGone();
		} finally {
			checking = false;
			arm();
		}
	};
	// The supervisor's end of the socket pair is readable, and nothing is ever written to it.
	if (lifetime instanceof Readable) {
		lifetime.once("end", () => void check(true));
		lifetime.resume();
	}
	arm();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
