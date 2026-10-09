/**
 * WHAT the supervisor knows about the host's activity: attached public clients, and the turns its
 * always-on observer connection sees start and settle on the internal socket. Feeds the idle-exit
 * decision. Split out of `host-lifecycle.ts`, which keeps the supervisor's orchestration (senpi#2566).
 */
import { type FSWatcher, watch } from "node:fs";
import { createConnection, Socket } from "node:net";
import { ClientOccupancy } from "./host-client-occupancy.ts";
import { type HostLifetimeOwner, hostOwnerGone, readHostOwner, sameHostOwner } from "./host-daemon-state.ts";
import { type HostActivity, IdleExitDecider, type IdleExitDecision } from "./host-lifecycle-policy.ts";
import { SessionRunActivity } from "./host-run-activity.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { activeTurnsForIdleDecision, createObserverLink, type ObserverLink } from "./observer-link.ts";
import { resolveSocketTransportAddress, sendSocketHandshake } from "./socket-transport.ts";

export interface SupervisorActivityOptions {
	readonly idleExitMs: number;
	readonly internalSocket: string;
	readonly internalSecret?: Buffer;
	/** The supervisor is leaving: the observer stops reconnecting. */
	readonly settled: () => boolean;
	/** Resets owner grace even for activity that starts and ends between lifecycle ticks. */
	readonly onActivity?: () => void;
}

export class SupervisorActivity {
	readonly decider: IdleExitDecider;
	readonly clients: ClientOccupancy;
	private readonly runs = new SessionRunActivity();
	private readonly observerLink: ObserverLink;
	private observerSocket: Socket | undefined;
	private readonly options: SupervisorActivityOptions;

	constructor(options: SupervisorActivityOptions) {
		this.options = options;
		// Everything `current()` reads exists before any client can be accepted: a connection admitted
		// during startup asks for the activity snapshot, and a successor's first `open_session` once
		// failed on a binding read before its initializer ran.
		this.decider = new IdleExitDecider(options.idleExitMs);
		this.clients = new ClientOccupancy(() => this.refresh());
		this.observerLink = createObserverLink({
			open: () => this.connectObserver(),
			settled: options.settled,
			retryDelayMs: 250,
			now: Date.now,
			setTimer: (run, ms) => {
				const timer = setTimeout(run, ms);
				timer.unref?.();
				return { cancel: () => clearTimeout(timer) };
			},
		});
	}

	current(): HostActivity {
		return {
			connections: this.clients.attachedCount,
			activeTurns: activeTurnsForIdleDecision({
				healthy: this.observerLink.healthy(),
				unhealthySince: this.observerLink.unhealthySince(),
				now: Date.now(),
				unknownGraceMs: this.decider.idleExitMs,
				observedBusy: this.runs.busySessions,
			}),
		};
	}

	refresh(): IdleExitDecision {
		const current = this.current();
		if (current.connections > 0 || current.activeTurns > 0 || this.clients.unclassifiedCount > 0)
			this.options.onActivity?.();
		return this.decider.update(current);
	}

	/** Owner death never turns an unknown observer snapshot into permission to stop a turn. */
	quiescent(): boolean {
		return (
			this.observerLink.healthy() &&
			this.runs.busySessions === 0 &&
			this.clients.attachedCount === 0 &&
			this.clients.unclassifiedCount === 0
		);
	}

	openObserver(): Promise<void> {
		return this.observerLink.open();
	}

	stopObserver(): void {
		this.observerLink.stop();
		this.observerSocket?.destroy();
	}

	private async connectObserver() {
		const secret = this.options.internalSecret;
		const next = createConnection(
			resolveSocketTransportAddress(this.options.internalSocket, process.platform, secret),
		);
		if (secret) sendSocketHandshake(next, secret);
		await waitForConnect(next, 5_000);
		this.observerSocket = next;
		attachJsonlLineReader(next, (line) => this.observeHostEvent(line), { maxLineLength: MAX_RPC_LINE_CHARACTERS });
		return {
			onLost: (handler: () => void) => {
				const lost = () => {
					handler();
					this.options.onActivity?.();
				};
				next.once("close", lost);
				next.once("error", lost);
			},
		};
	}

	private observeHostEvent(line: string): void {
		if (this.runs.observe(line)) this.refresh();
	}
}

/** Continuous quiet time, in addition to attach holds and confirmed owner death (#3044). */
export const OWNER_EXIT_GRACE_MS = 2_000;
const OWNER_PROBE_MAX_INTERVAL_MS = 5_000;

/**
 * Fresh starts inherit an event-loop pipe on POSIX and Windows. An existing supervisor cannot
 * receive a newly inherited fd, nor can a foreign handoff caller pass the original owner's fd:
 * those bindings use the OS start identity. Failed observations are never death.
 */
export class SupervisorOwner {
	private owner: HostLifetimeOwner | null | undefined;
	private pipe: Socket | undefined;
	private watcher: FSWatcher | undefined;
	private watchFailed = false;
	private nextProbeAt = 0;
	private probeIntervalMs = 1_000;
	private gone = false;
	private revision = 0;
	private stopped = false;
	private readonly idle = new IdleExitDecider(OWNER_EXIT_GRACE_MS, () => performance.now());
	private readonly generationDir: string;

	constructor(generationDir: string) {
		this.generationDir = generationDir;
	}

	async start(fd: number | undefined): Promise<void> {
		await this.reload();
		if (fd === undefined || this.owner == null) return;
		try {
			const pipe = new Socket({ fd, readable: true, writable: false });
			this.pipe = pipe;
			const bound = this.owner;
			let failed = false;
			const eof = (): void => {
				if (!failed && !this.stopped && sameHostOwner(this.owner, bound)) this.gone = true;
			};
			pipe.once("end", eof);
			// Windows may report a clean close without an end; an errored pipe remains unknown.
			if (process.platform === "win32") pipe.once("close", eof);
			pipe.once("error", () => {
				failed = true;
				if (this.pipe === pipe) this.pipe = undefined;
				pipe.destroy();
			});
			pipe.resume();
		} catch {
			// Inheritance was unavailable on this launch path: use the recorded OS identity.
			this.pipe = undefined;
		}
	}

	private async reload(): Promise<void> {
		const revision = ++this.revision;
		const next = await readHostOwner(this.generationDir);
		if (this.stopped || revision !== this.revision) return;
		if (!sameHostOwner(this.owner, next)) {
			this.pipe?.destroy();
			this.pipe = undefined;
			this.gone = false;
			this.nextProbeAt = 0;
			this.probeIntervalMs = 1_000;
			this.activity();
		}
		this.owner = next;
		if (next == null) {
			this.watcher?.close();
			this.watcher = undefined;
		} else if (!this.watcher && !this.watchFailed) {
			try {
				this.watcher = watch(this.generationDir, (_event, filename) => {
					if (filename?.toString() === "owner.json") void this.reload();
				});
				this.watcher.once("error", () => {
					this.watchFailed = true;
					this.watcher?.close();
					this.watcher = undefined;
				});
			} catch {
				// Exhausted or unavailable filesystem watches degrade to record polling, not startup failure.
				this.watchFailed = true;
			}
		}
	}

	activity(): void {
		this.idle.update({ connections: 1, activeTurns: 0 });
	}

	async shouldExit(activity: SupervisorActivity): Promise<boolean> {
		// Also discovers a first owner claimed on an initially unowned generation, without an fs watcher.
		if (!this.watcher) await this.reload();
		const owner = this.owner;
		const revision = this.revision;
		if (owner != null && !this.pipe && !this.gone && performance.now() >= this.nextProbeAt) {
			const gone = await hostOwnerGone(owner);
			if (this.stopped || revision !== this.revision) return false;
			this.gone = gone;
			this.nextProbeAt = performance.now() + this.probeIntervalMs;
			this.probeIntervalMs = Math.min(OWNER_PROBE_MAX_INTERVAL_MS, this.probeIntervalMs * 2);
		}
		const quiet = this.gone && owner != null && activity.quiescent();
		if (this.idle.update({ connections: quiet ? 0 : 1, activeTurns: 0 }) !== "exit") return false;
		// fs.watch may lag a new owner's atomic write. Its ensure holds a connection until this
		// publication, so re-read the record AND occupancy before authorizing synchronous shutdown.
		const current = await readHostOwner(this.generationDir);
		return !this.stopped && revision === this.revision && sameHostOwner(owner, current) && activity.quiescent();
	}

	stop(): void {
		this.stopped = true;
		this.watcher?.close();
		this.pipe?.destroy();
	}
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`observer connection to internal host timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onConnect = (): void => {
			cleanup();
			resolve();
		};
		const onError = (cause: Error): void => {
			cleanup();
			reject(cause);
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}
