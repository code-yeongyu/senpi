/**
 * Command watches: a PTY session's output, line-buffered and filtered. A durable (restartable) watch
 * counts its matched lines in a persisted rolling fire window and carries the runaway guard, which
 * pauses it with a visible notice only after a sustained flood; a busy watch is never muted, its
 * wakes are paced by the notifier instead. Output stays in the runtime's bounded history; a record
 * holds at most one unfinished line.
 */
import { MonitorLineBuffer } from "./monitor-line-buffer.ts";
import {
	allocateMonitorId,
	type MonitorFireWindow,
	type MonitorRecordBase,
	type MonitorSourceHost,
} from "./monitor-types.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { FIRE_BUDGET_WINDOW_MS, runawayPauseSummary } from "./shared.ts";
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
	/** Durability class from the manifest spec; non-ephemeral records carry the fire window and runaway guard. */
	readonly durabilityClass?: MonitorDurabilityClass;
	/** Persisted fire window re-bound by a restore, so a restart cannot reset the budget. */
	readonly fireWindow?: MonitorFireWindow;
	/** Durability deadline of a durable watch; omitted for an ephemeral one. */
	readonly expiresAt?: number;
	/** Output lines are a person's words (a chat bridge); goal continuation counts them as new input. */
	readonly humanInput?: boolean;
	/** Per-monitor wake-rate override of a persistent watch; unset uses terminal.monitorWakesPerHour. */
	readonly wakesPerHour?: number;
}

/** One-minute bucket of matched lines plus the run of consecutive flood minutes before it. */
interface RunawayWindow {
	minuteStartMs: number;
	count: number;
	floodMinutes: number;
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
	runaway: RunawayWindow | undefined;
	readonly wakesPerHour: number | undefined;
	unsubscribeOutput: (() => void) | undefined;
	unsubscribeExit: (() => void) | undefined;
	readonly humanInput: boolean;
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
			runaway: undefined,
			wakesPerHour: options.wakesPerHour,
			unsubscribeOutput: undefined,
			unsubscribeExit: undefined,
			humanInput: options.humanInput === true,
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
			this.#host.emit(record, {
				type: "line",
				id: record.id,
				description: record.description,
				line,
				...(record.humanInput ? { humanInput: true as const } : {}),
			});
			if (record.fireWindow !== undefined) {
				const now = Date.now();
				if (now - record.fireWindow.startMs >= FIRE_BUDGET_WINDOW_MS)
					record.fireWindow = { startMs: now, count: 0 };
				record.fireWindow.count += 1;
				if (this.#floodsRunaway(record, now)) {
					const guard = this.#host.runawayGuard();
					record.paused = true;
					this.#host.emit(record, {
						type: "summary",
						id: record.id,
						description: record.description,
						summary: runawayPauseSummary(record.id, guard.linesPerMinute, guard.minutes),
					});
					this.#host.changed();
				}
			}
		}
	}

	/**
	 * Count one matched line into the record's minute bucket. A minute with more lines than the guard
	 * allows is a flood minute; the watch trips once the current minute floods and the minutes right
	 * before it flooded too, `minutes` in a row. A quiet or skipped minute resets the run.
	 */
	#floodsRunaway(record: MonitorRecord, now: number): boolean {
		const guard = this.#host.runawayGuard();
		const previous = record.runaway;
		let current = previous;
		if (current === undefined || now - current.minuteStartMs >= 60_000) {
			const elapsedMinutes = previous === undefined ? 0 : Math.floor((now - previous.minuteStartMs) / 60_000);
			const previousFlooded =
				previous !== undefined && elapsedMinutes === 1 && previous.count > guard.linesPerMinute;
			current = {
				minuteStartMs: previous === undefined ? now : previous.minuteStartMs + elapsedMinutes * 60_000,
				count: 0,
				floodMinutes: previous !== undefined && previousFlooded ? previous.floodMinutes + 1 : 0,
			};
			record.runaway = current;
		}
		current.count += 1;
		return current.count > guard.linesPerMinute && current.floodMinutes + 1 >= guard.minutes;
	}

	#settle(record: MonitorRecord): void {
		if (record.settled) return;
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
		this.#records.delete(record.id);
		this.#host.changed();
		const exit = record.runtime.exitResult;
		const status = describeExit(record.runtime) ?? "exited";
		const code = exit?.exitCode;
		const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
		this.#host.emit(record, {
			type: "summary",
			id: record.id,
			description: record.description,
			// A timed-out watch was KILLED by its own timeout_ms deadline; say so instead of a
			// passive "timed_out" that reads like a mere observation. The exit code is
			// deliberately omitted in this branch: a killed child's code is noise, and
			// "killed at deadline" names the cause instead.
			summary: exit?.timedOut ? `watcher killed at deadline (${status})` : `watcher ${status}${codeText}`,
		});
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
