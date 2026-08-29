import { runAllAsyncCleanup, runAllCleanup } from "./file-monitor-cleanup.ts";
import {
	type FileMonitorEvent,
	FileMonitorRegistry,
	type RegisterFileMonitorOptions,
} from "./file-monitor-registry.ts";
import type {
	MonitorEvent,
	MonitorRearmResult,
	MonitorRecord,
	MonitorRegistryOptions,
	MonitorSnapshotEntry,
	RegisterMonitorOptions,
} from "./monitor-types.ts";
import { DEFAULT_MAX_SESSIONS } from "./shared.ts";
import { describeExit } from "./tools/spawn.ts";

export class MonitorRegistryCapacityError extends Error {}

export type {
	MonitorEvent,
	MonitorLineEvent,
	MonitorRearmResult,
	MonitorRegistryOptions,
	MonitorSnapshotEntry,
	MonitorSummaryEvent,
	RegisterMonitorOptions,
} from "./monitor-types.ts";

/**
 * Tracks active monitor sessions alongside the terminal manager's existing bash-id registry.
 * Output is deliberately retained only by TerminalRuntimeSession's bounded history; this
 * registry holds at most one unfinished line for each live monitor.
 */
export class MonitorRegistry {
	readonly #records = new Map<string, MonitorRecord>();
	readonly #emit: (event: MonitorEvent) => void;
	readonly #onChange: ((snapshot: readonly MonitorSnapshotEntry[]) => void) | undefined;
	readonly #files: FileMonitorRegistry;
	readonly #getTerminalSessionCount: (() => number) | undefined;
	readonly #maxSessions: number;

	constructor(emit: (event: MonitorEvent) => void, options?: MonitorRegistryOptions) {
		this.#emit = emit;
		this.#getTerminalSessionCount = options?.getTerminalSessionCount;
		this.#onChange = options?.onChange;
		this.#maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.#files = new FileMonitorRegistry({
			emitLine: (id, description, line) => this.#emit({ type: "line", id, description, line }),
			emitSummary: (id, description, summary) => this.#emit({ type: "summary", id, description, summary }),
			onChange: () => this.#notifyChange(),
			maxSessions: options?.maxSessions ?? DEFAULT_MAX_SESSIONS,
			...options?.fileMonitor,
		});
	}

	snapshot(): readonly MonitorSnapshotEntry[] {
		return [
			...[...this.#records.values()].map((record) => ({
				id: record.id,
				description: record.description,
				paused: record.paused,
				startedAtMs: record.startedAtMs,
			})),
			...this.#files.snapshot(),
		];
	}

	get fileCount(): number {
		return this.#files.capacityCount;
	}

	register(options: RegisterMonitorOptions): void {
		if (this.#getTerminalSessionCount) {
			if (this.#resourceCount() > this.#maxSessions) {
				throw new MonitorRegistryCapacityError(`Monitor capacity reached (${this.#maxSessions}).`);
			}
		} else {
			this.assertCapacity();
		}
		options.onBeforeEvents?.(options.id);
		const record: MonitorRecord = {
			id: options.id,
			description: options.description,
			startedAtMs: Date.now(),
			runtime: options.runtime,
			filter: options.filter,
			lineBuffer: "",
			paused: false,
			settled: false,
			unsubscribeOutput: undefined,
			unsubscribeExit: undefined,
		};
		let statePublicationAttempted = false;
		try {
			this.#records.set(record.id, record);
			statePublicationAttempted = true;
			this.#notifyChange();

			// Runtime output is already bounded. Read what was produced before monitor registration,
			// then subscribe synchronously so a fast watcher cannot lose its first line.
			this.#consume(record, record.runtime.fullOutput());
			record.unsubscribeOutput = record.runtime.onOutput((chunk) => this.#consume(record, chunk));
			record.unsubscribeExit = record.runtime.session.onExit(() => this.#settle(record));
			if (record.runtime.exited) this.#settle(record);
		} catch (error) {
			this.#records.delete(record.id);
			const failure = error instanceof Error ? error : new Error(String(error));
			try {
				runAllCleanup([
					() => this.#disposeRecord(record),
					...(statePublicationAttempted ? [() => this.#notifyChange()] : []),
				]);
			} catch (rollbackError) {
				throw new AggregateError([failure, rollbackError], "Monitor registration rollback failed.");
			}
			throw failure;
		}
	}

	async registerFile(
		options: Omit<RegisterFileMonitorOptions, "event"> & { readonly event: FileMonitorEvent },
	): Promise<string> {
		this.assertCapacity();
		return await this.#files.register(options);
	}

	hasCapacity(): boolean {
		return this.#resourceCount() < this.#maxSessions;
	}

	assertCapacity(): void {
		if (this.hasCapacity()) return;
		throw new MonitorRegistryCapacityError(`Monitor capacity reached (${this.#maxSessions}).`);
	}

	pauseAll(): string[] {
		const paused: string[] = [];
		for (const record of this.#records.values()) {
			if (record.paused) continue;
			record.paused = true;
			paused.push(record.id);
		}
		const filePaused = this.#files.pauseAll();
		if (paused.length > 0 || filePaused.length > 0) this.#notifyChange();
		return [...paused, ...filePaused];
	}

	rearm(id: string): MonitorRearmResult {
		const record = this.#records.get(id);
		if (!record) {
			const result = this.#files.rearm(id);
			if (result === "rearmed") this.#notifyChange();
			return result;
		}
		if (!record.paused) return "not_paused";
		record.paused = false;
		this.#notifyChange();
		return "rearmed";
	}

	async stopFile(id: string): Promise<boolean> {
		return await this.#files.stop(id);
	}

	async stopAllFiles(): Promise<number> {
		return await this.#files.stopAll();
	}

	dispose(): void {
		const records = [...this.#records.values()];
		this.#records.clear();
		runAllCleanup([
			...records.map((record) => () => this.#disposeRecord(record)),
			() => this.#files.dispose(),
			() => this.#notifyChange(),
		]);
	}

	async teardown(): Promise<void> {
		const records = [...this.#records.values()];
		this.#records.clear();
		await runAllAsyncCleanup([
			...records.map((record) => async () => this.#disposeRecord(record)),
			async () => await this.#files.teardown(),
			async () => this.#notifyChange(),
		]);
	}

	#notifyChange(): void {
		this.#onChange?.(this.snapshot());
	}

	#resourceCount(): number {
		return (this.#getTerminalSessionCount?.() ?? this.#records.size) + this.#files.capacityCount;
	}

	#consume(record: MonitorRecord, chunk: string): void {
		if (record.settled || chunk.length === 0) return;
		let remaining = record.lineBuffer + chunk;
		for (;;) {
			const newline = remaining.indexOf("\n");
			if (newline < 0) break;
			const rawLine = remaining.slice(0, newline);
			remaining = remaining.slice(newline + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (record.paused || (record.filter && !record.filter.test(line))) continue;
			this.#emit({ type: "line", id: record.id, description: record.description, line });
		}
		record.lineBuffer = remaining;
	}

	#settle(record: MonitorRecord): void {
		if (record.settled) return;
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
		this.#records.delete(record.id);
		this.#notifyChange();
		const status = describeExit(record.runtime) ?? "exited";
		const code = record.runtime.exitResult?.exitCode;
		const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
		this.#emit({
			type: "summary",
			id: record.id,
			description: record.description,
			summary: `watcher ${status}${codeText}`,
		});
	}

	#disposeRecord(record: MonitorRecord): void {
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
	}
}
