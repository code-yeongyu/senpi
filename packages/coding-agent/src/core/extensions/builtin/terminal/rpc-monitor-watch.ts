/**
 * One rpc watch: an observer per endpoint, joined again every 30 s so hosts that start later are
 * watched too, every delivered record turned into at most one line (rendered, or folded into a
 * coalescing window), and a checkpoint of what it last saw so a restore can report what changed while
 * nothing was watching.
 */
import { RpcMonitorCoalescer } from "./rpc-monitor-coalesce.ts";
import { openRpcObserver, type RpcObserver, type RpcRecord } from "./rpc-monitor-observer.ts";
import { RpcMonitorRenderer, sessionKey } from "./rpc-monitor-render.ts";
import {
	endpointSockets,
	matchesTask,
	type RpcEvents,
	type RpcTarget,
	subscriptionFor,
	wantsRecord,
} from "./rpc-monitor-targets.ts";

export const RPC_RESCAN_MS = 30_000;

/** What a restore compares against: each endpoint's host identity and each session's last status. */
export interface RpcMonitorCheckpoint {
	readonly hosts: Readonly<Record<string, { readonly instanceId: string; readonly generation: string }>>;
	readonly statuses: Readonly<Record<string, string>>;
}

export interface RpcWatchOptions {
	readonly agentDir: string;
	readonly target: RpcTarget;
	readonly events: RpcEvents;
	readonly exclude: readonly string[];
	/** Every line this watch reports. */
	readonly line: (line: string) => void;
	/** The watch's view changed (a host joined, a status moved): persist it. */
	readonly checkpoint?: (checkpoint: RpcMonitorCheckpoint) => void;
}

export class RpcMonitorWatch {
	readonly #options: RpcWatchOptions;
	readonly #observers = new Map<string, RpcObserver>();
	readonly #hosts = new Map<string, { instanceId: string; generation: string }>();
	readonly #renderer = new RpcMonitorRenderer();
	readonly #coalescer: RpcMonitorCoalescer;
	readonly #taskSessions = new Set<string>();
	#rescan: ReturnType<typeof setInterval> | undefined;
	#stopped = false;

	constructor(options: RpcWatchOptions) {
		this.#options = options;
		this.#coalescer = new RpcMonitorCoalescer(options.line);
	}

	/** Joins every endpoint now; resolves to the arm-time RESULT rows (one per matched session). */
	async start(): Promise<string[]> {
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
			const label = key.slice(key.lastIndexOf("#") + 1).slice(0, 8);
			const current = now.get(key);
			if (current === undefined) lines.push(`rpc ${label} closed (gone while detached)`);
			else if (current !== status)
				lines.push(`rpc ${label} status ${status} -> ${current} (changed while detached)`);
		}
		return lines;
	}

	stop(): void {
		this.#stopped = true;
		if (this.#rescan !== undefined) clearInterval(this.#rescan);
		this.#coalescer.dispose();
		for (const observer of this.#observers.values()) observer.close();
		this.#observers.clear();
	}

	async #join(): Promise<string[]> {
		const sockets = await endpointSockets(this.#options.agentDir).catch(() => [] as readonly string[]);
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
				record: (record) => this.#record(socket, record),
				closed: () => {
					this.#observers.delete(socket);
				},
			});
		} catch {
			return [];
		}
		this.#observers.set(socket, observer);
		const answer = await observer.subscribed.catch(() => undefined);
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
