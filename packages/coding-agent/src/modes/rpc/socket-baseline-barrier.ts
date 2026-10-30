import type { LegacyViewCursor } from "./legacy-view-cursor.ts";

/**
 * One peer's baseline attempt (R3.C6.4, S07a): the frames of a view frozen at a cut, written in their FIFO
 * position before every record queued behind them. `live` is rechecked after every await and before every
 * frame, so a stale attempt (detached, replaced, superseded, peer gone) writes nothing further; `end` runs
 * once on every path and releases the frozen source.
 */
export class BaselineBarrier {
	private cancelled = false;
	private ended = false;
	private readonly cursor: LegacyViewCursor;
	private readonly live: () => boolean;

	constructor(cursor: LegacyViewCursor, live: () => boolean) {
		this.cursor = cursor;
		this.live = live;
	}

	get active(): boolean {
		return !this.cancelled && !this.ended && this.live();
	}

	cancel(): void {
		this.cancelled = true;
		this.end();
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.cursor.release();
	}

	/**
	 * Writes `head` (a recovery's gap line) once the cursor has fixed its view, then the frames in order; `write`
	 * resolves once the sink accepted the line.
	 */
	async deliver(write: (line: string) => Promise<void>, head?: string): Promise<void> {
		try {
			if (!this.active) return;
			let line = await this.cursor.next();
			if (head !== undefined && this.active) await write(head);
			while (line !== undefined && this.active) {
				await write(line);
				line = await this.cursor.next();
			}
		} finally {
			this.end();
		}
	}
}
