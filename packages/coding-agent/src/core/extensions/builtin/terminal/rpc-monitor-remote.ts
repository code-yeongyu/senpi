/**
 * The remote half of an rpc watch: one `RpcRemoteSource` subscription for a `<device>/<session>` or
 * `<device>/*` target. Records go through the watch's own render path with the device in the socket's
 * place, so a remote line reads exactly like a local one. A resync after a gap reports each change once,
 * a turn end is reported once per `turnId`, and the source's cursor rides the monitor checkpoint.
 */
import type { RpcRecord } from "./rpc-monitor-observer.ts";
import { detachedLabel, type RpcMonitorRenderer, sessionKey } from "./rpc-monitor-render.ts";
import type { RpcEvents } from "./rpc-monitor-targets.ts";
import type {
	RpcRemoteSettledTurn,
	RpcRemoteSource,
	RpcRemoteState,
	RpcRemoteSubscription,
	RpcRemoteTarget,
} from "./rpc-remote-source.ts";

/** What a remote watch persists: the source's resume cursor and the turns already reported per session. */
export interface RpcRemoteCheckpoint {
	readonly cursor?: string;
	readonly settled: Readonly<Record<string, readonly string[]>>;
}

export interface RpcRemoteFeedHost {
	readonly renderer: RpcMonitorRenderer;
	readonly hosts: Map<string, { instanceId: string; generation: string }>;
	record(socket: string, record: RpcRecord): void;
	line(line: string): void;
	checkpoint(): void;
	ended(summary: string): void;
}

export interface RpcRemoteFeedOptions {
	readonly events: RpcEvents;
	readonly exclude: readonly string[];
	readonly source: RpcRemoteSource;
	readonly saved?: RpcRemoteCheckpoint;
}

const REMOTE_INSTANCE = "remote";
/** Turn ids remembered per session: enough to drop a resnapshot's repeats, bounded for a long watch. */
const SETTLED_KEPT = 16;

export class RpcRemoteFeed {
	readonly #target: RpcRemoteTarget;
	readonly #options: RpcRemoteFeedOptions;
	readonly #host: RpcRemoteFeedHost;
	readonly #settled = new Map<string, string[]>();
	#cursor: string | undefined;
	#opened: readonly RpcRemoteSettledTurn[] = [];
	#subscription: RpcRemoteSubscription | undefined;
	#lostReported = false;
	#stopped = false;

	constructor(target: RpcRemoteTarget, options: RpcRemoteFeedOptions, host: RpcRemoteFeedHost) {
		this.#target = target;
		this.#options = options;
		this.#host = host;
		for (const [key, turns] of Object.entries(options.saved?.settled ?? {})) this.#settled.set(key, [...turns]);
		this.#cursor = options.saved?.cursor;
	}

	/** Opens the subscription; resolves to the arm-time rows. Callbacks before the open resolves wait for it. */
	async start(): Promise<string[]> {
		const pending: Array<() => void> = [];
		let ready = false;
		const run = (step: () => void): void => {
			if (this.#stopped) return;
			if (ready) step();
			else pending.push(step);
		};
		const { events, exclude, source } = this.#options;
		const subscription = await source.open(
			this.#target,
			{ events, exclude, ...(this.#cursor === undefined ? {} : { resumeFrom: this.#cursor }) },
			{
				record: (record) => run(() => this.#record(record)),
				resynced: (state) => run(() => this.#resync(state)),
				cursor: (cursor) =>
					run(() => {
						this.#cursor = cursor;
						this.#host.checkpoint();
					}),
				lost: (reason) => run(() => this.#lost(reason)),
				ended: (reason) => run(() => this.#ended(reason)),
			},
		);
		if (this.#stopped) {
			subscription.stop();
			return [];
		}
		this.#subscription = subscription;
		const { initial } = subscription;
		const device = this.#target.device;
		this.#host.hosts.set(device, { instanceId: REMOTE_INSTANCE, generation: initial.generation ?? "" });
		this.#opened = initial.settledTurns ?? [];
		for (const turn of this.#opened) this.#remember(turnKey(device, turn), turn.turnId);
		if (initial.cursor !== undefined) this.#cursor = initial.cursor;
		const rows = this.#host.renderer.seed(device, initial.rows);
		this.#host.checkpoint();
		ready = true;
		for (const step of pending.splice(0)) step();
		return rows;
	}

	stop(): void {
		this.#stopped = true;
		this.#subscription?.stop();
		this.#subscription = undefined;
	}

	checkpoint(): RpcRemoteCheckpoint {
		const settled = Object.fromEntries([...this.#settled].map(([key, turns]) => [key, [...turns]]));
		return this.#cursor === undefined ? { settled } : { cursor: this.#cursor, settled };
	}

	/** After a restore: the turns that settled while nothing watched, which the saved checkpoint had not seen. */
	diffSettled(saved: RpcRemoteCheckpoint | undefined): string[] {
		return this.#opened
			.filter((turn) => !saved?.settled[turnKey(this.#target.device, turn)]?.includes(turn.turnId))
			.map((turn) => settledLine(turnKey(this.#target.device, turn), turn.turnId));
	}

	#record(record: RpcRecord): void {
		const device = this.#target.device;
		if (record.type !== "agent_settled" || typeof record.turnId !== "string") {
			this.#host.record(device, record);
			return;
		}
		const key = sessionKey(device, record);
		if (this.#seen(key, record.turnId)) return;
		this.#remember(key, record.turnId);
		this.#host.record(device, record);
		this.#host.checkpoint();
	}

	#resync(state: RpcRemoteState): void {
		const device = this.#target.device;
		const lines: string[] = [];
		const host = this.#host.hosts.get(device);
		if (state.generation !== undefined) {
			if (host !== undefined && host.generation !== state.generation)
				lines.push(`rpc host ${device} restarted (generation ${host.generation} -> ${state.generation})`);
			this.#host.hosts.set(device, { instanceId: REMOTE_INSTANCE, generation: state.generation });
		}
		const before = new Map([...this.#host.renderer.statuses()].filter(([key]) => key.startsWith(`${device}#`)));
		const now = new Map(state.rows.map((row) => [sessionKey(device, row), String(row.status)]));
		for (const [key, status] of now) {
			const was = before.get(key) ?? "unknown";
			if (was !== status)
				lines.push(`rpc ${detachedLabel(key)} status ${was} -> ${status} (changed while detached)`);
		}
		for (const key of before.keys())
			if (!now.has(key)) lines.push(`rpc ${detachedLabel(key)} closed (gone while detached)`);
		for (const turn of state.settledTurns ?? []) {
			const key = turnKey(device, turn);
			if (this.#seen(key, turn.turnId)) continue;
			this.#remember(key, turn.turnId);
			lines.push(settledLine(key, turn.turnId));
		}
		this.#host.renderer.forgetSocket(device);
		this.#host.renderer.seed(device, state.rows);
		if (state.cursor !== undefined) this.#cursor = state.cursor;
		this.#lostReported = false;
		for (const line of lines) this.#host.line(line);
		this.#host.checkpoint();
	}

	#lost(reason: string): void {
		if (this.#lostReported) return;
		this.#lostReported = true;
		this.#host.line(`rpc device ${this.#target.device} unreachable (${reason}); re-watching`);
	}

	#ended(reason: string): void {
		this.#host.line(`rpc ${this.#target.device}/${this.#target.session} access ended (${reason})`);
		this.#host.ended(`access ended (${reason})`);
	}

	#seen(key: string, turnId: string): boolean {
		return this.#settled.get(key)?.includes(turnId) === true;
	}

	#remember(key: string, turnId: string): void {
		const turns = this.#settled.get(key) ?? [];
		if (turns.includes(turnId)) return;
		turns.push(turnId);
		if (turns.length > SETTLED_KEPT) turns.shift();
		this.#settled.set(key, turns);
	}
}

function turnKey(device: string, turn: RpcRemoteSettledTurn): string {
	return `${device}#${turn.sessionId}`;
}

function settledLine(key: string, turnId: string): string {
	return `rpc ${detachedLabel(key)} turn ${turnId} settled while detached`;
}
