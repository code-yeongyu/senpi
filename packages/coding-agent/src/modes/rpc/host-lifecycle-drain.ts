/**
 * HOW a supervisor leaves without ending work: the handoff drain (SIGUSR1 to its child, a soft grace
 * that never kills busy sessions), the watch that turns a lost public entry into a drain, and the win32
 * identity watchdog that notices a child gone without an exit event. Split out of `host-lifecycle.ts`,
 * which keeps the supervisor's orchestration (senpi#2566). Nothing here sends a terminating signal.
 */
import type { ChildProcess } from "node:child_process";
import { processIsLive, readProcessStartTime } from "../app-server/daemon/process.ts";
import { DEFAULT_HANDOFF_GRACE_MS, HANDOFF_GRACE_MS_ENV, parseIdleExitMs } from "./host-lifecycle-policy.ts";
import { watchForSupersession } from "./host-supersession.ts";
import { errorMessage, supervisorLog } from "./host-supervisor-log.ts";
import type { SocketFileIdentity } from "./socket-ownership.ts";

export class SupervisorDrain {
	private draining = false;
	private graceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly child: ChildProcess;
	private readonly shuttingDown: () => boolean;

	constructor(child: ChildProcess, shuttingDown: () => boolean) {
		this.child = child;
		this.shuttingDown = shuttingDown;
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

	private requestChildDrain(): void {
		const { child } = this;
		if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(child.pid, "SIGUSR1");
			} catch (cause) {
				supervisorLog(`could not ask the host to drain: ${errorMessage(cause)}`);
			}
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
): () => void {
	return watchForSupersession({ path, identity, settled }, (loss) => {
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

/**
 * win32 only: a child whose identity changes or disappears has exited even when no exit event came.
 * A failed baseline read is UNKNOWN - readProcessStartTime THROWS when the 1s CIM probe fails, and a
 * supervisor that died on it took its host with it (`connect ENOENT`, `reported dead`) - so the
 * watchdog then starts without one and relies on its own comparisons.
 */
export async function watchWin32ChildIdentity(
	child: ChildProcess,
	shuttingDown: () => boolean,
	onGone: () => void,
): Promise<() => void> {
	const pid = child.pid;
	if (pid === undefined) return () => {};
	const childStartTime = await readProcessStartTime(pid, process.platform, 1_000).catch(() => undefined);
	let missingIdentityChecks = 0;
	let checking = false;
	const check = (): void => {
		if (shuttingDown() || checking || child.exitCode !== null || child.signalCode !== null) return;
		checking = true;
		void readProcessStartTime(pid, process.platform, 1_000)
			.then((currentStartTime) => {
				// An absent identity is only believed once kill(pid, 0) agrees the child is gone: this
				// probe is a 1s PowerShell CIM spawn polled every 500ms, so a loaded runner produced two
				// consecutive timeouts and shut down a healthy host. A timed-out probe means UNKNOWN.
				if (currentStartTime === undefined && !processIsLive(pid)) missingIdentityChecks++;
				else if (currentStartTime !== undefined) missingIdentityChecks = 0;
				const identityChanged =
					childStartTime !== undefined && currentStartTime !== undefined && currentStartTime !== childStartTime;
				if (identityChanged || missingIdentityChecks >= 2) onGone();
			})
			.catch(() => {})
			.finally(() => {
				checking = false;
			});
	};
	const timer = setInterval(check, 500);
	timer.unref?.();
	return () => clearInterval(timer);
}
