/**
 * Rpc watches as a monitor source: each record owns one `RpcMonitorWatch` and reports its lines through
 * the registry's one sink, so the fire stats, pause/rearm and the ended observer work as for command and
 * file watches. A paused watch counts the lines it drops; a line identical to the previous one is
 * dropped (consecutive dedupe), on top of the notifier's same-batch rule.
 */
import { allocateMonitorId, type MonitorRecordBase, type MonitorSourceHost } from "./monitor-types.ts";
import type { RpcEvents, RpcTarget } from "./rpc-monitor-targets.ts";
import { type RpcMonitorCheckpoint, RpcMonitorWatch } from "./rpc-monitor-watch.ts";

/**
 * The summary an RPC watch settles with when its own deadline fires. An RPC watch observes
 * other sessions and kills nothing, so this must not claim a kill; the same constant feeds
 * the ended-reason classifier so the two can never drift.
 */
const RPC_WATCHER_TIMED_OUT_SUMMARY = "watcher timed_out";

export interface RegisterRpcMonitorOptions {
	readonly description: string;
	readonly target: RpcTarget;
	/** The target as the caller wrote it (what the manifest records). */
	readonly targetText: string;
	readonly events: RpcEvents;
	readonly exclude: readonly string[];
	readonly filter?: RegExp;
	readonly persistent: boolean;
	readonly timeoutMs?: number;
	readonly expiresAt?: number;
	readonly monitorId?: string;
	readonly agentDir: string;
	/** Endpoint discovery override (tests); defaults to the endpoints registered under `agentDir`. */
	readonly endpoints?: () => Promise<readonly string[]>;
	/** A restore's saved view: the lines for what changed are injected once the watch has joined. */
	readonly restoredFrom?: RpcMonitorCheckpoint;
	readonly onCheckpoint?: (monitorId: string, checkpoint: RpcMonitorCheckpoint) => void;
}

export interface RpcMonitorRecord extends MonitorRecordBase {
	readonly rpcWatch: RpcMonitorWatch;
	readonly targetText: string;
	mutedDropped: number;
	lastLine: string | undefined;
	readonly deadline: ReturnType<typeof setTimeout> | undefined;
}

export class RpcMonitorSource {
	readonly #records = new Map<string, RpcMonitorRecord>();
	readonly #host: MonitorSourceHost;
	#nextId = 1;

	constructor(host: MonitorSourceHost) {
		this.#host = host;
	}

	get(id: string): RpcMonitorRecord | undefined {
		return this.#records.get(id);
	}

	values(): IterableIterator<RpcMonitorRecord> {
		return this.#records.values();
	}

	keys(): IterableIterator<string> {
		return this.#records.keys();
	}

	/** Arms the watch; resolves to its runtime id, stable id and the arm-time session rows. */
	async register(options: RegisterRpcMonitorOptions): Promise<{ id: string; monitorId: string; rows: string[] }> {
		const id = `rpc_${this.#nextId++}`;
		const monitorId = options.monitorId ?? allocateMonitorId();
		const watch = new RpcMonitorWatch({
			agentDir: options.agentDir,
			target: options.target,
			events: options.events,
			exclude: options.exclude,
			...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
			line: (line) => this.#line(id, line),
			...(options.onCheckpoint === undefined
				? {}
				: { checkpoint: (checkpoint) => options.onCheckpoint?.(monitorId, checkpoint) }),
		});
		const record: RpcMonitorRecord = {
			id,
			monitorId,
			description: options.description,
			startedAtMs: Date.now(),
			command: null,
			filter: options.filter,
			persistent: options.persistent,
			deadlineMs: options.persistent || options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs,
			fireCount: 0,
			lastFiredAtMs: null,
			expiresAt: options.expiresAt,
			paused: false,
			settled: false,
			rpcWatch: watch,
			targetText: options.targetText,
			mutedDropped: 0,
			lastLine: undefined,
			deadline:
				options.persistent || options.timeoutMs === undefined
					? undefined
					: setTimeout(() => this.settle(id, RPC_WATCHER_TIMED_OUT_SUMMARY), options.timeoutMs),
		};
		this.#records.set(id, record);
		this.#host.changed();
		const rows = await watch.start();
		if (options.restoredFrom !== undefined)
			for (const line of watch.diffSince(options.restoredFrom)) this.#line(id, line);
		return { id, monitorId, rows };
	}

	/** Ends one watch; false when the id is not a live rpc watch. */
	settle(id: string, summary: string): boolean {
		const record = this.#records.get(id);
		if (record === undefined || record.settled) return false;
		record.settled = true;
		record.rpcWatch.stop();
		clearTimeout(record.deadline);
		this.#records.delete(id);
		this.#host.changed();
		if (summary !== "watcher disposed")
			this.#host.emit(record, { type: "summary", id, description: record.description, summary });
		this.#host.ended(
			record,
			summary === RPC_WATCHER_TIMED_OUT_SUMMARY ? "timeout" : summary === "watcher disposed" ? "disposed" : "killed",
			null,
		);
		return true;
	}

	settleAll(summary: string): number {
		const ids = [...this.#records.keys()];
		for (const id of ids) this.settle(id, summary);
		return ids.length;
	}

	#line(id: string, line: string): void {
		const record = this.#records.get(id);
		if (record === undefined || record.settled) return;
		if (record.filter instanceof RegExp && !record.filter.test(line)) return;
		if (line === record.lastLine) return;
		record.lastLine = line;
		if (record.paused) {
			record.mutedDropped += 1;
			return;
		}
		this.#host.emit(record, { type: "line", id, description: record.description, line });
	}
}
