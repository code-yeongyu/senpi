/**
 * Command watches: a PTY session's output, line-buffered and filtered, with the durable fire budget
 * that auto-mutes a restartable watch that fires too often. Output stays in the runtime's bounded
 * history; a record holds at most one unfinished line.
 */
import { MonitorLineBuffer } from "./monitor-line-buffer.ts";
import {
	allocateMonitorId,
	type MonitorFireWindow,
	type MonitorRecordBase,
	type MonitorSourceHost,
} from "./monitor-types.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { DEFAULT_DURABLE_MONITOR_FIRE_BUDGET, FIRE_BUDGET_AUTO_MUTE_SUMMARY, FIRE_BUDGET_WINDOW_MS } from "./shared.ts";
import type { MonitorDurabilityClass } from "./terminal-manifest.ts";
import { describeExit } from "./tools/spawn.ts";

export interface RegisterMonitorOptions {
	readonly id: string;
	readonly command?: string | null;
	readonly persistent?: boolean;
	readonly deadlineMs?: number | null;
	/** Caller-supplied stable identity so a restore can re-bind the same "mon_" id. */
	readonly monitorId?: string;
	readonly description: string;
	readonly runtime: TerminalRuntimeSession;
	readonly filter?: RegExp;
	/** Durability class from the manifest spec; non-ephemeral records carry the fire budget. */
	readonly durabilityClass?: MonitorDurabilityClass;
	/** Persisted fire window re-bound by a restore, so a restart cannot reset the budget. */
	readonly fireWindow?: MonitorFireWindow;
	/** Durability deadline of a durable watch; omitted for an ephemeral one. */
	readonly expiresAt?: number;
}

export interface MonitorRecord extends MonitorRecordBase {
	readonly id: string;
	readonly monitorId: string;
	readonly sessionId: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly command: string | null;
	readonly persistent: boolean;
	readonly deadlineMs: number | null;
	fireCount: number;
	lastFiredAtMs: number | null;
	readonly expiresAt: number | undefined;
	readonly runtime: TerminalRuntimeSession;
	readonly filter: RegExp | undefined;
	lineBuffer: MonitorLineBuffer;
	mutedDropped: number;
	paused: boolean;
	settled: boolean;
	fireWindow: MonitorFireWindow | undefined;
	unsubscribeOutput: (() => void) | undefined;
	unsubscribeExit: (() => void) | undefined;
}

export class CommandMonitorSource {
	readonly #records = new Map<string, MonitorRecord>();
	readonly #host: MonitorSourceHost;

	constructor(host: MonitorSourceHost) {
		this.#host = host;
	}

	get(id: string): MonitorRecord | undefined {
		return this.#records.get(id);
	}

	values(): IterableIterator<MonitorRecord> {
		return this.#records.values();
	}

	keys(): IterableIterator<string> {
		return this.#records.keys();
	}

	register(options: RegisterMonitorOptions): string {
		const durable = options.durabilityClass !== undefined && options.durabilityClass !== "ephemeral";
		const record: MonitorRecord = {
			id: options.id,
			monitorId: options.monitorId ?? allocateMonitorId(),
			sessionId: options.id,
			description: options.description,
			startedAtMs: Date.now(),
			command: options.command ?? null,
			persistent: options.persistent ?? durable,
			deadlineMs: (options.persistent ?? durable) ? null : (options.deadlineMs ?? null),
			fireCount: 0,
			lastFiredAtMs: null,
			expiresAt: options.expiresAt,
			runtime: options.runtime,
			filter: options.filter,
			lineBuffer: new MonitorLineBuffer(),
			mutedDropped: 0,
			paused: false,
			settled: false,
			fireWindow: durable ? { ...(options.fireWindow ?? { startMs: Date.now(), count: 0 }) } : undefined,
			unsubscribeOutput: undefined,
			unsubscribeExit: undefined,
		};
		this.#records.set(record.id, record);
		this.#host.changed();

		// Runtime output is already bounded. Read what was produced before monitor registration,
		// then subscribe synchronously so a fast watcher cannot lose its first line.
		this.#consume(record, record.runtime.fullOutput());
		record.unsubscribeOutput = record.runtime.onOutput((chunk) => this.#consume(record, chunk));
		record.unsubscribeExit = record.runtime.session.onExit(() => this.#settle(record));
		if (record.runtime.exited) this.#settle(record);
		return record.monitorId;
	}

	/** Re-bind a persisted fire window onto the record for a durable monitor id (a restore re-arms the budget). */
	adoptFireWindow(monitorId: string, fireWindow: MonitorFireWindow): boolean {
		for (const record of this.#records.values()) {
			if (record.monitorId !== monitorId) continue;
			record.fireWindow = { ...fireWindow };
			return true;
		}
		return false;
	}

	dispose(): void {
		for (const record of [...this.#records.values()]) this.#disposeRecord(record);
		this.#records.clear();
	}

	#consume(record: MonitorRecord, chunk: string): void {
		if (record.settled || chunk.length === 0) return;
		for (const line of record.lineBuffer.append(chunk)) {
			const matchesFilter = !record.filter || record.filter.test(line);
			if (!matchesFilter) continue;
			if (record.paused) {
				record.mutedDropped += 1;
				continue;
			}
			this.#host.emit(record, { type: "line", id: record.id, description: record.description, line });
			if (record.fireWindow !== undefined) {
				const now = Date.now();
				if (now - record.fireWindow.startMs >= FIRE_BUDGET_WINDOW_MS)
					record.fireWindow = { startMs: now, count: 0 };
				record.fireWindow.count += 1;
				if (record.fireWindow.count >= DEFAULT_DURABLE_MONITOR_FIRE_BUDGET) {
					record.paused = true;
					this.#host.emit(record, {
						type: "summary",
						id: record.id,
						description: record.description,
						summary: FIRE_BUDGET_AUTO_MUTE_SUMMARY,
					});
					this.#host.changed();
				}
			}
		}
	}

	#settle(record: MonitorRecord): void {
		if (record.settled) return;
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
		this.#records.delete(record.id);
		this.#host.changed();
		const status = describeExit(record.runtime) ?? "exited";
		const code = record.runtime.exitResult?.exitCode;
		const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
		this.#host.emit(record, {
			type: "summary",
			id: record.id,
			description: record.description,
			summary: `watcher ${status}${codeText}`,
		});
		const exit = record.runtime.exitResult;
		this.#host.ended(record, exit?.timedOut ? "timeout" : exit?.cancelled ? "killed" : "exit", code ?? null);
	}

	#disposeRecord(record: MonitorRecord): void {
		if (record.settled) return;
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
		this.#records.delete(record.id);
		this.#host.ended(record, "disposed", null);
	}
}
