/**
 * Tracks live monitors across their sources (command watches over PTY output, native file watches),
 * alongside the terminal manager's bash-id registry. Every source emits through one sink here, so the
 * fire stats, the wake budget's change notifications and the ended observer apply to all of them.
 */
import { CommandMonitorSource, type RegisterMonitorOptions } from "./command-monitor-source.ts";
import { FileMonitorSource, type RegisterFileMonitorOptions } from "./file-monitor-source.ts";
import type {
	MonitorEndedEvent,
	MonitorEndedReason,
	MonitorEvent,
	MonitorFireWindow,
	MonitorRearmResult,
	MonitorRecordBase,
	MonitorResumeResult,
	MonitorSnapshotEntry,
	MonitorSourceHost,
} from "./monitor-types.ts";
import { loadRpcMonitorSource } from "./rpc-monitor.lazy.ts";
import type { RegisterRpcMonitorOptions, RpcMonitorSource } from "./rpc-monitor-source.ts";
import type { MonitorRunawayGuard } from "./settings.ts";
import { DEFAULT_MONITOR_RUNAWAY_LINES_PER_MINUTE, DEFAULT_MONITOR_RUNAWAY_MINUTES } from "./shared.ts";

export type { RegisterMonitorOptions } from "./command-monitor-source.ts";
export type { RegisterFileMonitorOptions } from "./file-monitor-source.ts";
export {
	allocateMonitorId,
	type MonitorEndedEvent,
	type MonitorEndedReason,
	type MonitorEvent,
	type MonitorFireWindow,
	type MonitorLineEvent,
	type MonitorRearmResult,
	type MonitorResumeResult,
	type MonitorSnapshotEntry,
	type MonitorSummaryEvent,
} from "./monitor-types.ts";

export interface MonitorRegistryOptions {
	/** Observes every registry transition (register/pause/rearm/settle/dispose) with the live snapshot. */
	readonly onChange?: (snapshot: readonly MonitorSnapshotEntry[]) => void;
	/** Fire-stat refreshes are separate from lifecycle transitions (which persist the manifest). */
	readonly onFire?: (snapshot: readonly MonitorSnapshotEntry[]) => void;
	/** Observes each monitor exactly once when it leaves the registry. */
	readonly onEnded?: (event: MonitorEndedEvent) => void;
	/** Reserves one shared terminal capacity slot for a native watch. */
	readonly reserve?: () => (() => void) | null;
}

export class MonitorRegistry {
	readonly #emit: (event: MonitorEvent) => void;
	readonly #onChange: ((snapshot: readonly MonitorSnapshotEntry[]) => void) | undefined;
	readonly #onEnded: ((event: MonitorEndedEvent) => void) | undefined;
	readonly #onFire: ((snapshot: readonly MonitorSnapshotEntry[]) => void) | undefined;
	readonly #commands: CommandMonitorSource;
	readonly #files: FileMonitorSource;
	readonly #host: MonitorSourceHost;
	#rpc: RpcMonitorSource | undefined;
	#parked = false;
	#runawayGuard: MonitorRunawayGuard = {
		linesPerMinute: DEFAULT_MONITOR_RUNAWAY_LINES_PER_MINUTE,
		minutes: DEFAULT_MONITOR_RUNAWAY_MINUTES,
	};

	constructor(emit: (event: MonitorEvent) => void, options?: MonitorRegistryOptions) {
		this.#emit = emit;
		this.#onChange = options?.onChange;
		this.#onEnded = options?.onEnded;
		this.#onFire = options?.onFire;
		const host: MonitorSourceHost = {
			emit: (record, event) => this.#emitForRecord(record, event),
			emitRaw: (event) => this.#emit(event),
			ended: (record, reason, exitCode) => this.#emitEnded(record, reason, exitCode),
			changed: () => this.#notifyChange(),
			runawayGuard: () => this.#runawayGuard,
		};
		this.#host = host;
		this.#commands = new CommandMonitorSource(host);
		this.#files = new FileMonitorSource(host, options?.reserve);
	}

	/** Apply the resolved runaway-guard settings; the registry outlives a reload, the settings do not. */
	setRunawayGuard(guard: MonitorRunawayGuard): void {
		this.#runawayGuard = guard;
	}

	/**
	 * Wake pacing of a live watch: only persistent command watches are paced. Returns the watch's
	 * own wake-rate override (undefined = the setting) or undefined when the watch is not paced.
	 */
	wakePacing(id: string): { readonly wakesPerHour: number | undefined } | undefined {
		const record = this.#commands.get(id);
		if (record === undefined || !record.persistent) return undefined;
		return { wakesPerHour: record.wakesPerHour };
	}

	/** Attachment parking is independent of persisted monitor mute and wake budgets. */
	setParked(parked: boolean): void {
		if (this.#parked === parked) return;
		this.#parked = parked;
		this.#files.setParked(parked);
	}

	snapshot(): readonly MonitorSnapshotEntry[] {
		return [...this.#commands.values(), ...this.#files.values(), ...(this.#rpc?.values() ?? [])].map((record) => ({
			id: record.id,
			monitorId: record.monitorId,
			description: record.description,
			paused: record.paused,
			startedAtMs: record.startedAtMs,
			command: record.command,
			filter: record.filter?.source ?? null,
			persistent: record.persistent,
			deadlineMs: record.deadlineMs,
			fireCount: record.fireCount,
			lastFiredAtMs: record.lastFiredAtMs,
			expiresAt: record.expiresAt,
			fireWindow: "fireWindow" in record ? record.fireWindow : undefined,
		}));
	}

	registerFile(options: RegisterFileMonitorOptions): Promise<{ id: string; monitorId: string }> {
		return this.#files.registerFile(options);
	}

	/** Live identity tuple of one file watch; undefined when the id is not a live file watch. */
	fileCheckpoint(id: string) {
		return this.#files.fileCheckpoint(id);
	}

	/** Emit one restored-watch line through the SAME sink a live watch uses (coalescing, wake budget). */
	emitFileLine(id: string, line: string): boolean {
		return this.#files.get(id) !== undefined && this.emitLine(id, line);
	}

	/** Inject one line into a live command or file watch's event stream (e.g. a restore notice). */
	emitLine(id: string, line: string): boolean {
		const record = this.#commands.get(id) ?? this.#files.get(id) ?? this.#rpc?.get(id);
		if (!record || record.settled) return false;
		this.#emitForRecord(record, { type: "line", id: record.id, description: record.description, line });
		return true;
	}

	stopFile(id: string): Promise<boolean> {
		return this.#files.stopFile(id);
	}

	stopAllFiles(): Promise<number> {
		return this.#files.stopAllFiles();
	}

	register(options: RegisterMonitorOptions): string {
		return this.#commands.register(options);
	}

	/** Arms an rpc watch (the source loads on the first one); resolves with the arm-time session rows. */
	async registerRpc(options: RegisterRpcMonitorOptions): Promise<{ id: string; monitorId: string; rows: string[] }> {
		if (this.#rpc === undefined) {
			const { RpcMonitorSource } = await loadRpcMonitorSource();
			this.#rpc ??= new RpcMonitorSource(this.#host);
		}
		return this.#rpc.register(options);
	}

	stopRpc(id: string): boolean {
		return this.#rpc?.settle(id, "watcher killed") ?? false;
	}

	stopAllRpc(): number {
		return this.#rpc?.settleAll("watcher killed") ?? 0;
	}

	pause(ids: readonly string[]): string[] {
		const paused: string[] = [];
		for (const id of ids) {
			const record = this.#commands.get(id) ?? this.#files.get(id) ?? this.#rpc?.get(id);
			if (!record || record.paused) continue;
			record.paused = true;
			if ("watch" in record) record.watch.pause();
			paused.push(record.id);
		}
		if (paused.length > 0) this.#notifyChange();
		return paused;
	}

	pauseAll(): string[] {
		return this.pause([...this.#commands.keys(), ...this.#files.keys(), ...(this.#rpc?.keys() ?? [])]);
	}

	resume(ids?: readonly string[]): MonitorResumeResult[] {
		const candidates = ids ?? [...this.#commands.keys(), ...this.#files.keys(), ...(this.#rpc?.keys() ?? [])];
		const resumed: MonitorResumeResult[] = [];
		for (const id of candidates) {
			const record = this.#commands.get(id) ?? this.#files.get(id) ?? this.#rpc?.get(id);
			if (!record?.paused) continue;
			record.paused = false;
			const mutedDropped = "mutedDropped" in record ? record.mutedDropped : 0;
			if ("mutedDropped" in record) record.mutedDropped = 0;
			// A rearm (or any resume) restarts the rolling fire count while keeping its window start,
			// and gives the runaway guard a clean minute history.
			if ("fireWindow" in record && record.fireWindow !== undefined) record.fireWindow.count = 0;
			if ("runaway" in record) record.runaway = undefined;
			resumed.push({ id: record.id, mutedDropped });
			if ("watch" in record && !this.#files.parked) record.watch.resume();
		}
		if (resumed.length > 0) this.#notifyChange();
		return resumed;
	}

	mutedDropped(id: string): number {
		return this.#commands.get(id)?.mutedDropped ?? this.#rpc?.get(id)?.mutedDropped ?? 0;
	}

	rearm(id: string): MonitorRearmResult {
		const record = this.#commands.get(id) ?? this.#files.get(id) ?? this.#rpc?.get(id);
		if (!record) return "not_found";
		if (!record.paused) return "not_paused";
		this.resume([id]);
		return "rearmed";
	}

	/** Re-bind a persisted fire window onto the record for a durable monitor id (a restore re-arms the budget). */
	adoptFireWindow(monitorId: string, fireWindow: MonitorFireWindow): boolean {
		return this.#commands.adoptFireWindow(monitorId, fireWindow);
	}

	dispose(): void {
		this.#commands.dispose();
		this.#files.dispose();
		this.#rpc?.settleAll("watcher disposed");
		this.#notifyChange();
	}

	#notifyChange(): void {
		this.#onChange?.(this.snapshot());
	}

	#emitForRecord(record: MonitorRecordBase, event: MonitorEvent): void {
		record.fireCount += 1;
		record.lastFiredAtMs = Date.now();
		this.#emit(event);
		if (!record.settled) this.#onFire?.(this.snapshot());
	}

	#emitEnded(record: MonitorRecordBase, reason: MonitorEndedReason, exitCode: number | null): void {
		this.#onEnded?.({
			id: record.id,
			description: record.description,
			startedAtMs: record.startedAtMs,
			endedAtMs: Date.now(),
			reason,
			exitCode,
			fireCount: record.fireCount,
		});
	}
}
