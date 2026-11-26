/**
 * Ended detached cells whose completion notification still waits for their written files to settle. They stay in the
 * wake-source count until the notification is handed over: the engine takes custody of a notification only at
 * delivery, and a wake-source record, unlike an extension-opened obligation, is retired by the engine when a session is
 * restored, so a process that dies mid-settlement cannot leave the session waiting forever.
 */
export class SettlingCells<Cell> {
	readonly #cells = new Set<Cell>();
	readonly #onRelease: () => void;

	constructor(onRelease: () => void) {
		this.#onRelease = onRelease;
	}

	/** Counts `cell` from now on; the returned release stops counting it, once. */
	hold(cell: Cell): () => void {
		this.#cells.add(cell);
		return () => {
			if (this.#cells.delete(cell)) this.#onRelease();
		};
	}

	values(): readonly Cell[] {
		return [...this.#cells];
	}
}
