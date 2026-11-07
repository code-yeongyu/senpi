/**
 * Overflow bookkeeping of the monitor notifier: events that did not fit a monitor's batch. Line
 * bodies are written to the monitor's overflow file in chunks (when a spill sink exists), and the
 * wake that carries the monitor names the file; without a file the wake says how many were omitted.
 */
import type { MonitorEvent } from "./monitor-registry.ts";

/** Lines are written out in chunks of this many, so a burst never sits whole in memory. */
const SPILL_CHUNK_LINES = 256;

export interface MonitorSpillResult {
	readonly path: string;
	/** The file rotated to `<path>.1` while this chunk was written. */
	readonly rotated: boolean;
}

export type MonitorSpill = (id: string, lines: readonly string[]) => MonitorSpillResult | undefined;

export interface MonitorOverflow {
	readonly id: string;
	readonly description: string;
	count: number;
	kinds: Set<MonitorEvent["type"]>;
	humanInput: boolean;
	pending: string[];
	spilled: number;
	path: string | undefined;
	rotated: boolean;
}

export class OverflowBook {
	readonly #spill: MonitorSpill | undefined;
	readonly #entries = new Map<string, MonitorOverflow>();

	constructor(spill: MonitorSpill | undefined) {
		this.#spill = spill;
	}

	get(id: string): MonitorOverflow | undefined {
		return this.#entries.get(id);
	}

	count(id: string): number {
		return this.#entries.get(id)?.count ?? 0;
	}

	ids(): string[] {
		return [...this.#entries.keys()];
	}

	record(event: MonitorEvent, body: string): void {
		const overflow = this.#entries.get(event.id) ?? {
			id: event.id,
			description: event.description,
			count: 0,
			kinds: new Set<MonitorEvent["type"]>(),
			humanInput: false,
			pending: [],
			spilled: 0,
			path: undefined,
			rotated: false,
		};
		overflow.count += 1;
		overflow.kinds.add(event.type);
		if (event.type === "line" && event.humanInput === true) overflow.humanInput = true;
		this.#entries.set(event.id, overflow);
		if (this.#spill === undefined) return;
		overflow.pending.push(body);
		if (overflow.pending.length >= SPILL_CHUNK_LINES) this.flush(event.id);
	}

	flush(id: string): void {
		const overflow = this.#entries.get(id);
		if (overflow === undefined || overflow.pending.length === 0 || this.#spill === undefined) return;
		const result = this.#spill(id, overflow.pending);
		if (result !== undefined) {
			overflow.spilled += overflow.pending.length;
			overflow.path = result.path;
			overflow.rotated ||= result.rotated;
		}
		overflow.pending = [];
	}

	/** The notice a wake carries for this monitor's overflow; "" when nothing overflowed. */
	notice(id: string): string {
		const overflow = this.#entries.get(id);
		if (overflow === undefined || overflow.count === 0) return "";
		const notices: string[] = [];
		if (overflow.spilled > 0 && overflow.path !== undefined) {
			const rotated = overflow.rotated ? `; earlier ones in ${overflow.path}.1` : "";
			notices.push(`[${overflow.spilled} more lines in ${overflow.path}${rotated}]`);
		}
		const unspilled = overflow.count - overflow.spilled;
		if (unspilled > 0)
			notices.push(`[${unspilled} additional event lines omitted; peek bash_output for full history.]`);
		return notices.join("\n");
	}

	delete(id: string): void {
		this.#entries.delete(id);
	}

	clear(): void {
		this.#entries.clear();
	}
}
