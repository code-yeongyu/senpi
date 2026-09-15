import type { EvalDetachedCellSnapshot } from "./detached-cell-contract.ts";

export const TERMINAL_SNAPSHOT_CAP = 32;

/** Bounded LRU of settled-cell snapshots; without it every settled cell pins its result and closures for the session lifetime (#1695). */
export class TerminalSnapshotStore {
	readonly #snapshots = new Map<string, EvalDetachedCellSnapshot>();
	readonly #cap: number;

	constructor(cap = TERMINAL_SNAPSHOT_CAP) {
		this.#cap = cap;
	}

	remember(snapshot: EvalDetachedCellSnapshot): void {
		this.#snapshots.delete(snapshot.cellId);
		this.#snapshots.set(snapshot.cellId, snapshot);
		while (this.#snapshots.size > this.#cap) {
			const oldest = this.#snapshots.keys().next();
			if (oldest.done === true) break;
			this.#snapshots.delete(oldest.value);
		}
	}

	get(cellId: string): EvalDetachedCellSnapshot | undefined {
		return this.#snapshots.get(cellId);
	}

	delete(cellId: string): void {
		this.#snapshots.delete(cellId);
	}

	clear(): void {
		this.#snapshots.clear();
	}
}
