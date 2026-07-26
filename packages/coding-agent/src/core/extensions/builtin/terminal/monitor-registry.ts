import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { describeExit } from "./tools/spawn.ts";

export interface MonitorLineEvent {
	readonly type: "line";
	readonly id: string;
	readonly description: string;
	readonly line: string;
}

export interface MonitorSummaryEvent {
	readonly type: "summary";
	readonly id: string;
	readonly description: string;
	readonly summary: string;
}

export type MonitorEvent = MonitorLineEvent | MonitorSummaryEvent;

export type MonitorRearmResult = "rearmed" | "not_paused" | "not_found";

export interface RegisterMonitorOptions {
	readonly id: string;
	readonly description: string;
	readonly runtime: TerminalRuntimeSession;
	readonly filter?: RegExp;
}

interface MonitorRecord {
	readonly id: string;
	readonly description: string;
	readonly runtime: TerminalRuntimeSession;
	readonly filter: RegExp | undefined;
	lineBuffer: string;
	paused: boolean;
	settled: boolean;
	unsubscribeOutput: (() => void) | undefined;
	unsubscribeExit: (() => void) | undefined;
}

/**
 * Tracks active monitor sessions alongside the terminal manager's existing bash-id registry.
 * Output is deliberately retained only by TerminalRuntimeSession's bounded history; this
 * registry holds at most one unfinished line for each live monitor.
 */
export class MonitorRegistry {
	readonly #records = new Map<string, MonitorRecord>();
	readonly #emit: (event: MonitorEvent) => void;

	constructor(emit: (event: MonitorEvent) => void) {
		this.#emit = emit;
	}

	register(options: RegisterMonitorOptions): void {
		const record: MonitorRecord = {
			id: options.id,
			description: options.description,
			runtime: options.runtime,
			filter: options.filter,
			lineBuffer: "",
			paused: false,
			settled: false,
			unsubscribeOutput: undefined,
			unsubscribeExit: undefined,
		};
		this.#records.set(record.id, record);

		// Runtime output is already bounded. Read what was produced before monitor registration,
		// then subscribe synchronously so a fast watcher cannot lose its first line.
		this.#consume(record, record.runtime.fullOutput());
		record.unsubscribeOutput = record.runtime.onOutput((chunk) => this.#consume(record, chunk));
		record.unsubscribeExit = record.runtime.session.onExit(() => this.#settle(record));
		if (record.runtime.exited) this.#settle(record);
	}

	pauseAll(): string[] {
		const paused: string[] = [];
		for (const record of this.#records.values()) {
			if (record.paused) continue;
			record.paused = true;
			paused.push(record.id);
		}
		return paused;
	}

	rearm(id: string): MonitorRearmResult {
		const record = this.#records.get(id);
		if (!record) return "not_found";
		if (!record.paused) return "not_paused";
		record.paused = false;
		return "rearmed";
	}

	dispose(): void {
		for (const record of this.#records.values()) this.#disposeRecord(record);
		this.#records.clear();
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
