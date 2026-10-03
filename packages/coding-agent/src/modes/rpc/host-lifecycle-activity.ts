/**
 * WHAT the supervisor knows about the host's activity: attached public clients, and the turns its
 * always-on observer connection sees start and settle on the internal socket. Feeds the idle-exit
 * decision. Split out of `host-lifecycle.ts`, which keeps the supervisor's orchestration (senpi#2566).
 */
import { createConnection, type Socket } from "node:net";
import { ClientOccupancy } from "./host-client-occupancy.ts";
import { type HostActivity, IdleExitDecider, type IdleExitDecision } from "./host-lifecycle-policy.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { activeTurnsForIdleDecision, createObserverLink, type ObserverLink } from "./observer-link.ts";
import { resolveSocketTransportAddress, sendSocketHandshake } from "./socket-transport.ts";

export interface SupervisorActivityOptions {
	readonly idleExitMs: number;
	readonly internalSocket: string;
	readonly internalSecret?: Buffer;
	/** The supervisor is leaving: the observer stops reconnecting. */
	readonly settled: () => boolean;
}

export class SupervisorActivity {
	readonly decider: IdleExitDecider;
	readonly clients: ClientOccupancy;
	private readonly busySessions = new Map<string, number>();
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
				observedBusy: this.countBusySessions(),
			}),
		};
	}

	refresh(): IdleExitDecision {
		return this.decider.update(this.current());
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
				next.once("close", handler);
				next.once("error", handler);
			},
		};
	}

	private countBusySessions(): number {
		let busy = 0;
		for (const count of this.busySessions.values()) if (count > 0) busy++;
		return busy;
	}

	private observeHostEvent(line: string): void {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof event !== "object" || event === null) return;
		const type = Reflect.get(event, "type");
		const sessionId = Reflect.get(event, "sessionId");
		if (typeof sessionId !== "string") return;
		const busy = this.busySessions.get(sessionId);
		if (type === "agent_start") this.busySessions.set(sessionId, (busy ?? 0) + 1);
		else if (type === "agent_settled") this.busySessions.set(sessionId, Math.max(0, (busy ?? 1) - 1));
		else return;
		this.refresh();
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
