import type { EvalDetachedCellSnapshot } from "./detached-cell-contract.ts";
import type { RetainedContentPart, SettledContentPart, SettledImageSpill } from "./settled-image-spill.ts";

export const TERMINAL_SNAPSHOT_CAP = 32;

export interface TerminalSnapshotStoreOptions {
	readonly cap?: number;
	/** Upper bound on the estimated in-memory bytes of all retained snapshots; 0 keeps only the count cap. */
	readonly byteBudget?: number;
	/** Moves image payloads to disk; without it images stay in memory under the byte budget. */
	readonly spill?: SettledImageSpill;
}

interface StoredSnapshot {
	/** Served by `list()`: every part except spilled images, so listing never reads the disk. */
	readonly snapshot: EvalDetachedCellSnapshot;
	readonly parts: readonly RetainedContentPart[];
	readonly bytes: number;
}

/**
 * Bounded LRU of settled-cell snapshots; without it every settled cell pins its result and closures for
 * the session lifetime (#1695). Bounded by count and by estimated in-memory bytes, with image payloads
 * spilled to disk and re-read on `get` (#2259); the newest snapshot is always kept.
 */
export class TerminalSnapshotStore {
	readonly #snapshots = new Map<string, StoredSnapshot>();
	readonly #cap: number;
	readonly #byteBudget: number;
	readonly #spill: SettledImageSpill | undefined;
	#bytes = 0;

	constructor(options: TerminalSnapshotStoreOptions = {}) {
		this.#cap = options.cap ?? TERMINAL_SNAPSHOT_CAP;
		this.#byteBudget = options.byteBudget ?? 0;
		this.#spill = options.spill;
	}

	get bytes(): number {
		return this.#bytes;
	}

	remember(snapshot: EvalDetachedCellSnapshot): void {
		this.delete(snapshot.cellId);
		const content = snapshot.result.content;
		const parts = this.#spill?.spill(snapshot.cellId, content) ?? content;
		const inMemory = parts.filter((part): part is SettledContentPart => part.type !== "spilled-image");
		const stored = inMemory.length === content.length ? snapshot : withContent(snapshot, inMemory);
		const bytes = estimateSnapshotBytes(stored);
		this.#snapshots.set(snapshot.cellId, { snapshot: stored, parts, bytes });
		this.#bytes += bytes;
		while (this.#snapshots.size > 1 && (this.#snapshots.size > this.#cap || this.#overBudget())) {
			const oldest = this.#snapshots.keys().next();
			if (oldest.done === true) break;
			this.delete(oldest.value);
		}
	}

	get(cellId: string): EvalDetachedCellSnapshot | undefined {
		const entry = this.#snapshots.get(cellId);
		if (
			entry === undefined ||
			this.#spill === undefined ||
			entry.parts.length === entry.snapshot.result.content.length
		)
			return entry?.snapshot;
		return withContent(entry.snapshot, this.#spill.hydrate(entry.parts));
	}

	delete(cellId: string): void {
		const entry = this.#snapshots.get(cellId);
		if (entry === undefined) return;
		this.#snapshots.delete(cellId);
		this.#bytes -= entry.bytes;
		this.#spill?.release(entry.parts);
	}

	list(): readonly EvalDetachedCellSnapshot[] {
		return [...this.#snapshots.values()].map((entry) => entry.snapshot);
	}

	clear(): void {
		this.#snapshots.clear();
		this.#bytes = 0;
		this.#spill?.clear();
	}

	#overBudget(): boolean {
		return this.#byteBudget > 0 && this.#bytes > this.#byteBudget;
	}
}

function withContent(
	snapshot: EvalDetachedCellSnapshot,
	content: readonly SettledContentPart[],
): EvalDetachedCellSnapshot {
	return { ...snapshot, result: { ...snapshot.result, content: [...content] } };
}

export function estimateSnapshotBytes(snapshot: EvalDetachedCellSnapshot): number {
	let bytes = snapshot.outputTail.length * 2;
	for (const part of snapshot.result.content) {
		bytes += part.type === "text" ? part.text.length * 2 : part.data.length;
	}
	for (const cell of snapshot.result.details.cells ?? []) {
		bytes += (cell.output.length + cell.code.length) * 2;
	}
	const jsonOutputs = snapshot.result.details.jsonOutputs;
	if (jsonOutputs !== undefined && jsonOutputs.length > 0) bytes += JSON.stringify(jsonOutputs).length;
	return bytes;
}
