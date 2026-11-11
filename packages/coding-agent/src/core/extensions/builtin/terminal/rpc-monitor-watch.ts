/**
 * One rpc watch: an observer per endpoint, joined again every 30 s so hosts that start later are
 * watched too, every delivered record turned into at most one line (rendered, or folded into a
 * coalescing window), and a checkpoint of what it last saw so a restore can report what changed while
 * nothing was watching.
 */
import { RpcMonitorCoalescer } from "./rpc-monitor-coalesce.ts";
import { openRpcObserver, type RpcObserver, type RpcRecord } from "./rpc-monitor-observer.ts";
import { type RpcRemoteCheckpoint, RpcRemoteFeed } from "./rpc-monitor-remote.ts";
import { detachedLabel, RpcMonitorRenderer, sessionKey } from "./rpc-monitor-render.ts";
import {
	endpointSockets,
	matchesTask,
	type RpcEvents,
	type RpcTarget,
	subscriptionFor,
	wantsRecord,
} from "./rpc-monitor-targets.ts";
import { currentRpcRemoteSource, type RpcRemoteSource } from "./rpc-remote-source.ts";

export const RPC_RESCAN_MS = 30_000;

/** What a restore compares against: each endpoint's host identity and each session's last status. */
export interface RpcMonitorCheckpoint {
	readonly hosts: Readonly<Record<string, { readonly instanceId: string; readonly generation: string }>>;
	readonly statuses: Readonly<Record<string, string>>;
	/** A remote target's resume position (absent for local targets). */
	readonly remote?: RpcRemoteCheckpoint;
}

export interface RpcWatchOptions {
	readonly agentDir: string;
	readonly target: RpcTarget;
	readonly events: RpcEvents;
	readonly exclude: readonly string[];
	/** Where to look for endpoints; defaults to every endpoint registered under `agentDir`. */
	readonly endpoints?: () => Promise<readonly string[]>;
	/** Every line this watch reports. */
	readonly line: (line: string) => void;
	/** The watch's view changed (a host joined, a status moved): persist it. */
	readonly checkpoint?: (checkpoint: RpcMonitorCheckpoint) => void;
	/** The source serving a remote target; defaults to the one an extension registered. */
	readonly remoteSource?: RpcRemoteSource;
	/** A restore's saved view: a remote target resumes from its cursor. */
	readonly restoredFrom?: RpcMonitorCheckpoint;
	/** A remote target's access ended for good: the monitor settles with this summary. */
	readonly ended?: (summary: string) => void;
}

export class RpcMonitorWatch {
	readonly #options: RpcWatchOptions;
	readonly #observers = new Map<string, RpcObserver>();
	readonly #hosts = new Map<string, { instanceId: string; generation: string }>();
	readonly #renderer = new RpcMonitorRenderer();
	readonly #coalescer: RpcMonitorCoalescer;
	readonly #taskSessions = new Set<string>();
	#rescan: ReturnType<typeof setInterval> | undefined;
	#remote: RpcRemoteFeed | undefined;
	#stopped = false;

	constructor(options: RpcWatchOptions) {
		this.#options = options;
		this.#coalescer = new RpcMonitorCoalescer(options.line);
	}

	/** Joins every endpoint now; resolves to the arm-time RESULT rows (one per matched session). */
	async start(): Promise<string[]> {
		const { target } = this.#options;
		if (target.kind === "remote") return this.#startRemote(target.device, target.session);
		const rows = await this.#join();
		this.#rescan = setInterval(() => void this.#join(), RPC_RESCAN_MS);
		this.#rescan.unref?.();
		return rows;
	}

	/** The current checkpoint: host identities and last statuses. */
	checkpoint(): RpcMonitorCheckpoint {
		return {
			hosts: Object.fromEntries(this.#hosts),
			statuses: Object.fromEntries(this.#renderer.statuses()),
			...(this.#remote === undefined ? {} : { remote: this.#remote.checkpoint() }),
		};
	}

	/** Lines for what changed between a saved checkpoint and what this watch sees now. */
	diffSince(saved: RpcMonitorCheckpoint): string[] {
		const lines: string[] = [];
		for (const [socket, host] of this.#hosts) {
			const before = saved.hosts[socket];
			// seq restarts with a generation, so only the generation says the host restarted.
			if (before !== undefined && before.generation !== host.generation)
				lines.push(`rpc host ${socket} restarted (generation ${before.generation} -> ${host.generation})`);
		}
		const now = this.#renderer.statuses();
		for (const [key, status] of Object.entries(saved.statuses)) {
			const label = detachedLabel(key);
			const current = now.get(key);
			// Only a host that answered can say a session is gone; otherwise it may be alive but unreachable
			// or no longer matched by the re-resolved target.
			const socket = key.slice(0, key.lastIndexOf("#"));
			if (current === undefined)
				lines.push(
					this.#hosts.has(socket) && this.#options.target.kind !== "children"
						? `rpc ${label} closed (gone while detached)`
						: this.#hosts.has(socket)
							? `rpc ${label} no longer listed (closed or no longer a child while detached)`
							: `rpc ${label} unreachable (its host did not answer)`,
				);
			else if (current !== status)
				lines.push(`rpc ${label} status ${status} -> ${current} (changed while detached)`);
		}
		if (this.#remote !== undefined) lines.push(...this.#remote.diffSettled(saved.remote));
		return lines;
	}

	stop(): void {
		this.#stopped = true;
		if (this.#rescan !== undefined) clearInterval(this.#rescan);
		this.#coalescer.dispose();
		for (const observer of this.#observers.values()) observer.close();
		this.#observers.clear();
		this.#remote?.stop();
	}

	/** A remote target is served by the registered source instead of endpoint sockets; render is shared. */
	#startRemote(device: string, session: string): Promise<string[]> {
		const { events, exclude, restoredFrom } = this.#options;
		const source = this.#options.remoteSource ?? currentRpcRemoteSource();
		if (source === undefined)
			return Promise.reject(new Error("remote targets need the omo remote surface; no remote source is registered"));
		this.#remote = new RpcRemoteFeed(
			{ device, session },
			{ events, exclude, source, ...(restoredFrom?.remote === undefined ? {} : { saved: restoredFrom.remote }) },
			{
				renderer: this.#renderer,
				hosts: this.#hosts,
				record: (socket, record) => this.#record(socket, record),
				line: (line) => this.#options.line(line),
				checkpoint: () => this.#options.checkpoint?.(this.checkpoint()),
				ended: (summary) => this.#options.ended?.(summary),
			},
		);
		return this.#remote.start();
	}

	async #join(): Promise<string[]> {
		const list = this.#options.endpoints ?? (() => endpointSockets(this.#options.agentDir));
		const sockets = await list().catch(() => [] as readonly string[]);
		const fresh = sockets.filter((socket) => !this.#observers.has(socket));
		const rows = await Promise.all(fresh.map((socket) => this.#observe(socket)));
		return rows.flat();
	}

	async #observe(socket: string): Promise<string[]> {
		if (this.#stopped) return [];
		const { target, events } = this.#options;
		let observer: RpcObserver;
		try {
			observer = await openRpcObserver(socket, subscriptionFor(target, events), {
				record: (record) => {
					if (!this.#stopped) this.#record(socket, record);
				},
				closed: () => this.#lost(socket, observer),
			});
		} catch {
			return [];
		}
		// A stop that landed while this observer was connecting has already closed every other one.
		if (this.#stopped) {
			observer.close();
			return [];
		}
		this.#observers.set(socket, observer);
		const answer = await observer.subscribed.catch(() => undefined);
		if (this.#stopped) {
			observer.close();
			return [];
		}
		const data = answer?.data as Record<string, unknown> | undefined;
		if (data === undefined) return [];
		this.#hosts.set(socket, { instanceId: String(data.hostInstanceId), generation: String(data.hostGeneration) });
		const snapshot = (Array.isArray(data.snapshot) ? data.snapshot : []) as RpcRecord[];
		const matched = snapshot.filter((row) => matchesTask(target, row));
		for (const row of matched) this.#taskSessions.add(sessionKey(socket, row));
		// An explicit id names one session: an endpoint whose snapshot did not match it is dropped.
		if (target.kind !== "all" && target.kind !== "children" && matched.length === 0) {
			observer.close();
			this.#observers.delete(socket);
			return [];
		}
		const rows = this.#renderer.seed(socket, matched);
		this.#options.checkpoint?.(this.checkpoint());
		return rows;
	}

	/** An endpoint's connection ended: say so once, and forget what it reported until it is joined again. */
	#lost(socket: string, observer: RpcObserver): void {
		if (this.#observers.get(socket) !== observer) return;
		this.#observers.delete(socket);
		if (this.#stopped) return;
		const forgotten = this.#renderer.forgetSocket(socket);
		for (const key of [...this.#taskSessions]) if (key.startsWith(`${socket}#`)) this.#taskSessions.delete(key);
		if (this.#hosts.delete(socket) || forgotten > 0) {
			this.#options.line(
				`rpc host ${socket} gone (${forgotten} session${forgotten === 1 ? "" : "s"} no longer watched)`,
			);
			this.#options.checkpoint?.(this.checkpoint());
		}
	}

	#record(socket: string, record: RpcRecord): void {
		const { target, events, exclude } = this.#options;
		const type = String(record.type);
		if (!wantsRecord(events, exclude, type)) return;
		const key = sessionKey(socket, record);
		if (target.kind === "task") {
			if (matchesTask(target, record)) this.#taskSessions.add(key);
			if (!this.#taskSessions.has(key)) return;
		}
		if (this.#coalescer.accept(key, () => this.#renderer.label(socket, record), record)) return;
		const line = this.#renderer.render(socket, record);
		if (line === undefined) return;
		this.#options.line(line);
		if (type === "session_status") this.#options.checkpoint?.(this.checkpoint());
	}
}
