/**
 * HOW a supervisor leaves without ending work: the handoff drain (SIGUSR1 to its child, a soft grace
 * that never kills busy sessions), the watch that turns a lost public entry into a drain, and the win32
 * identity watchdog that notices a child gone without an exit event. Split out of `host-lifecycle.ts`,
 * which keeps the supervisor's orchestration (senpi#2566). Nothing here sends a terminating signal.
 */
import type { ChildProcess } from "node:child_process";
import { readProcessStartTime } from "../../utils/process-identity.ts";
import type { HostStopSender } from "./host-crash-record.ts";
import type { HostGenerationPaths } from "./host-daemon-paths.ts";
import { DEFAULT_HANDOFF_GRACE_MS, HANDOFF_GRACE_MS_ENV, parseIdleExitMs } from "./host-lifecycle-policy.ts";
import { watchDrainRequest, writeDrainRequest, writeDrainWatch } from "./host-stop-intent.ts";
import { type SupersessionPointer, watchForSupersession } from "./host-supersession.ts";
import { errorMessage, supervisorLog } from "./host-supervisor-log.ts";
import type { SocketFileIdentity } from "./socket-ownership.ts";

export class SupervisorDrain {
	private draining = false;
	private graceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly child: ChildProcess;
	private readonly shuttingDown: () => boolean;
	private readonly beginStopping: () => void;
	private readonly relay: { readonly file: string; readonly sender: HostStopSender } | undefined;

	/**
	 * `relay` is the child's drain-request file (host-stop-intent.ts): the one way to reach a child
	 * on every platform. Without it the request is the POSIX signal alone.
	 */
	constructor(
		child: ChildProcess,
		shuttingDown: () => boolean,
		beginStopping: () => void = () => {},
		relay?: { readonly file: string; readonly sender: HostStopSender },
	) {
		this.child = child;
		this.shuttingDown = shuttingDown;
		this.beginStopping = beginStopping;
		this.relay = relay;
	}

	get active(): boolean {
		return this.draining;
	}

	/**
	 * Ask the child to announce and park attached sessions as turns/requests settle. The supervisor
	 * owns the soft grace from this instant; expiry rescans but NEVER kills busy sessions. Child
	 * exit ends the supervisor regardless of clients that keep their connections open.
	 */
	drain(): void {
		if (this.draining || this.shuttingDown()) return;
		this.draining = true;
		this.beginStopping();
		supervisorLog("draining into the next generation");
		const graceMs = parseIdleExitMs(process.env[HANDOFF_GRACE_MS_ENV]) ?? DEFAULT_HANDOFF_GRACE_MS;
		this.graceTimer = setTimeout(() => {
			supervisorLog(JSON.stringify({ event: "handoff_grace_expired", graceMs }));
			this.requestChildDrain();
		}, graceMs);
		this.graceTimer.unref();
		// The listening handle is deliberately NOT closed: libuv unlinks a pipe's bound NAME when it
		// closes, and after a handoff that name is the successor's entry. Nothing can reach this
		// listener by path any more (the rename moved the name), and the accept guard turns away
		// whatever raced it, so leaving the handle open until exit costs nothing and keeps the
		// public path continuously answerable - no window where a client finds no socket at all.
		this.requestChildDrain();
	}

	stop(): void {
		if (this.graceTimer) clearTimeout(this.graceTimer);
	}

	/**
	 * The signal-free drain request (#3653): armed BEFORE it is advertised, so an asker that finds the
	 * marker never writes into a generation that is not yet reading. A marker that cannot be written
	 * only leaves this generation reachable by the POSIX signal, as before.
	 */
	async acceptRequests(generation: HostGenerationPaths): Promise<() => void> {
		const stop = watchDrainRequest(generation.drainRequestFile, (request) => {
			supervisorLog(`drain requested (${request.reason})`);
			this.drain();
		});
		await writeDrainWatch(generation.drainWatchFile, { pid: process.pid }).catch((cause) => {
			supervisorLog(`cannot advertise the drain request: ${errorMessage(cause)}`);
		});
		return stop;
	}

	private requestChildDrain(): void {
		const { child, relay } = this;
		if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
		if (relay) {
			void writeDrainRequest(relay.file, { sender: relay.sender, reason: "supervisor_drain" }).catch((cause) => {
				supervisorLog(`could not relay the drain to the host: ${errorMessage(cause)}`);
			});
		}
		// win32 has no SIGUSR1; on POSIX it stays the immediate wake ahead of the next poll of the relay.
		if (process.platform === "win32") return;
		try {
			process.kill(child.pid, "SIGUSR1");
		} catch (cause) {
			supervisorLog(`could not ask the host to drain: ${errorMessage(cause)}`);
		}
	}
}

/**
 * Losing the public entry IS a drain request: nothing can reach this supervisor by path any more, and
 * the handoff that replaced it may never have signalled (#1893). A name that was deleted rather than
 * taken over is the same loss with nobody serving the path (#1961).
 */
export function drainOnPublicSocketLoss(
	path: string,
	identity: SocketFileIdentity | undefined,
	settled: () => boolean,
	drain: SupervisorDrain,
	onReplaced: () => void,
	pointer?: SupersessionPointer,
): () => void {
	return watchForSupersession({ path, identity, settled, ...(pointer && { pointer }) }, (loss) => {
		// A REPLACED entry names a live replacer: the registration and settings this generation
		// would release on its way out belong to that replacer now (#2536).
		if (loss === "replaced") onReplaced();
		supervisorLog(
			loss === "absent"
				? "the public socket entry is gone; nothing can reach this generation; draining"
				: "another generation owns the public socket; draining this one",
		);
		drain.drain();
	});
}

const CHILD_IDENTITY_TICK_MS = 500;
/** Ticks before the first repeated start-time read; the gap doubles after every read up to the cap (one a minute). */
const CHILD_IDENTITY_READ_GAP_TICKS = 10;
const CHILD_IDENTITY_READ_GAP_MAX_TICKS = 120;

type ChildLiveness = "alive" | "dead" | "unknown";

/**
 * kill(pid, 0) spawns nothing. On win32 it opens the pid and reads its exit code, so ESRCH also covers a child
 * that exited while a handle still pins its pid. EPERM or any other error cannot say whose process the pid is now.
 */
function childLiveness(pid: number): ChildLiveness {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (cause) {
		return cause instanceof Error && "code" in cause && cause.code === "ESRCH" ? "dead" : "unknown";
	}
}

/**
 * win32 only: a child that is gone, or whose pid now names another process, has exited even when no exit event came.
 *
 * The start time (a cold PowerShell CIM spawn) is read ONCE, at registration: it never changes while the pid is
 * live, and reading it every tick cost one or two WMI cold starts a second for the host's whole life (senpi#4684).
 * Each tick is a free `childLiveness`. Two dead ticks in a row are death. The pid can only be reused after the
 * child died, and our own child cannot answer EPERM, so the start time is read again only when the pid looked
 * dead and answers again, or liveness is inconclusive; a different start time is then death. Those reads, and the
 * retries of a failed registration read, back off to one a minute. A failed or absent read is UNKNOWN, never
 * death: a supervisor that died on a timed-out probe took its host with it (`connect ENOENT`, `reported dead`).
 */
export async function watchWin32ChildIdentity(
	child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
	shuttingDown: () => boolean,
	onGone: () => void,
): Promise<() => void> {
	const pid = child.pid;
	if (pid === undefined) return () => {};
	const readStartTime = () => readProcessStartTime(pid, process.platform, 1_000);
	let baseline = await readStartTime().catch(() => undefined);
	// A late registration read is only adopted while every tick since spawn has seen the child alive.
	let adoptable = true;
	let suspect = false;
	let deadTicks = 0;
	let reading = false;
	let ended = false;
	let ticksUntilRead = 0;
	let readGapTicks = CHILD_IDENTITY_READ_GAP_TICKS;
	const backOff = (): void => {
		ticksUntilRead = readGapTicks;
		readGapTicks = Math.min(readGapTicks * 2, CHILD_IDENTITY_READ_GAP_MAX_TICKS);
	};
	const end = (): void => {
		ended = true;
		onGone();
	};
	const settle = (current: string | undefined): void => {
		if (ended) return;
		if (baseline === undefined) {
			if (current !== undefined && adoptable && childLiveness(pid) === "alive") baseline = current;
			else backOff();
			return;
		}
		if (current !== undefined && current !== baseline) return end();
		if (current === baseline) suspect = false;
		backOff();
	};
	const check = (): void => {
		if (ended || shuttingDown() || child.exitCode !== null || child.signalCode !== null) return;
		if (ticksUntilRead > 0) ticksUntilRead--;
		const liveness = childLiveness(pid);
		if (liveness === "dead") {
			deadTicks++;
			if (deadTicks >= 2) return end();
			suspect = true;
			adoptable = false;
			return;
		}
		if (deadTicks > 0 || liveness === "unknown") {
			suspect = true;
			adoptable = false;
		}
		deadTicks = 0;
		const wantRead = baseline === undefined ? adoptable : suspect;
		if (!wantRead || reading || ticksUntilRead > 0) return;
		reading = true;
		void readStartTime()
			.then(settle, () => {
				if (!ended) backOff();
			})
			.finally(() => {
				reading = false;
			});
	};
	const timer = setInterval(check, CHILD_IDENTITY_TICK_MS);
	timer.unref?.();
	return () => {
		ended = true;
		clearInterval(timer);
	};
}
