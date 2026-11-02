import { nextRenderRevision } from "@earendil-works/pi-tui";
import {
	registerTuiRenderCacheSource,
	type TuiRenderCacheTotals,
} from "../../../core/memory-report/memory-report-registry.ts";

// Process-wide totals over every live tool card, kept by O(1) updates; the memory report reads them.
const totals = { components: 0, cachedLines: 0, images: 0, finishedCards: 0, cachedLinesBytes: 0, resultBytes: 0 };
let totalsReported = false;

/** 8 bytes per array slot: the same estimate the TUI's frame figure uses, so the two compare. */
const BYTES_PER_LINE_SLOT = 8;

/** Byte cost of a cached line set: 2 per UTF-16 code unit plus the array slots. */
function lineArrayBytes(lines: readonly string[]): number {
	let bytes = lines.length * BYTES_PER_LINE_SLOT;
	for (const line of lines) bytes += line.length * 2;
	return bytes;
}

function readTotals(): TuiRenderCacheTotals {
	return { ...totals };
}

/** One tool card's rendered-lines cache and render revision, counted in the process-wide totals. */
export class ToolExecutionRenderCache {
	#lines: string[] | undefined;
	#signature: string | undefined;
	#width: number | undefined;
	#images = 0;
	#resultBytes = 0;
	#finished = false;
	#disposed = false;
	#revision = nextRenderRevision();

	constructor() {
		totals.components++;
		if (totalsReported) return;
		totalsReported = true;
		registerTuiRenderCacheSource(readTotals);
	}

	/** Changes with every invalidation, so a finished card can skip rendering an unchanged frame. */
	get revision(): number {
		return this.#revision;
	}

	read(width: number, signature: string): string[] | undefined {
		if (!this.#lines || this.#width !== width || this.#signature !== signature) return undefined;
		return [...this.#lines];
	}

	store(width: number, signature: string, lines: readonly string[]): void {
		this.#dropLines();
		this.#width = width;
		this.#signature = signature;
		this.#lines = [...lines];
		totals.cachedLines += lines.length;
		totals.cachedLinesBytes += lineArrayBytes(lines);
	}

	invalidate(): void {
		this.#dropLines();
		this.#revision = nextRenderRevision();
	}

	/** Image parts the card's current result holds. */
	setImages(count: number): void {
		totals.images += count - this.#images;
		this.#images = count;
	}

	/**
	 * The card finished; \`bytes\` is the serialized size of its retained \`result\`, computed once by the
	 * component at finalize. A streaming card never calls this, so its \`resultBytes\` stays the last
	 * finalized figure - never a partial render's. Calling again replaces the earlier figure.
	 */
	finalizeResult(bytes: number): void {
		if (this.#finished) totals.resultBytes -= this.#resultBytes;
		else {
			this.#finished = true;
			totals.finishedCards++;
		}
		this.#resultBytes = bytes;
		totals.resultBytes += bytes;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#dropLines();
		this.setImages(0);
		if (this.#finished) {
			totals.finishedCards--;
			totals.resultBytes -= this.#resultBytes;
		}
		totals.components--;
	}

	#dropLines(): void {
		totals.cachedLines -= this.#lines?.length ?? 0;
		if (this.#lines !== undefined) totals.cachedLinesBytes -= lineArrayBytes(this.#lines);
		this.#lines = undefined;
		this.#signature = undefined;
		this.#width = undefined;
	}
}

/** Serialized size of a card's retained result: the JSON of its content parts plus the details payload. */
export function serializedToolResultBytes(result: unknown): number {
	if (typeof result !== "object" || result === null) return 0;
	let bytes = 0;
	try {
		bytes += JSON.stringify(Reflect.get(result, "content") ?? null)?.length ?? 0;
		const details: unknown = Reflect.get(result, "details");
		if (details !== undefined) bytes += JSON.stringify(details)?.length ?? 0;
	} catch {
		// An unserializable payload reports what serialized; accounting never breaks the card.
	}
	return bytes;
}
