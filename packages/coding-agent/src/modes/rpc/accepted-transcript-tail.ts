import type { TranscriptPersistence, TranscriptTransition } from "../../core/session-transcript-journal.ts";
import { protocolId } from "./compact-recovery-ids.ts";
import { type StagedContent, type TransferStaging, TransferStagingError } from "./compact-transfer-staging.ts";

/**
 * Tail bytes one epoch's transcript may hold in its store, resident and spilled together, in stored UTF-16LE bytes
 * (RULING-21 (3)): its unpersisted entries plus every segment kept for a held cut, in the current tail and in any
 * superseded tail a live cut still holds (carry 65a). It bounds the spool those can grow, not RAM: sixteen times the
 * 16 MiB in-memory tail it replaces.
 */
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 256 * 1024 * 1024;
/**
 * Tail bytes the staging store may hold in RAM, unspilled, when an entry is staged: what bounds memory when the spool
 * lags or failed. Never below the 16 MiB of UTF-8 the old tail allowed, as UTF-16 stores at most two bytes per byte.
 */
export const TRANSCRIPT_TAIL_RESIDENT_BYTES = 32 * 1024 * 1024;
const TAIL_KIND = protocolId("transcript-tail");

/** The tail bytes one transcript's tails hold in its store, kept segments included, against their one bound. */
export class TailBudget {
	readonly max: number;
	held = 0;

	constructor(max = DEFAULT_TRANSCRIPT_TAIL_BYTES) {
		this.max = max;
	}
}

/**
 * Stages one accepted entry's text against both tail bounds, `held` being the bytes the transcript's tails already
 * hold; undefined, with nothing allocated, when a bound refuses it.
 */
function stageTailEntry(
	staging: TransferStaging,
	budget: Pick<TailBudget, "held" | "max">,
	index: number,
	text: string,
): StagedContent | undefined {
	const bytes = text.length * 2;
	if (budget.held + staging.stagedBytes + bytes > budget.max) return undefined;
	if (staging.residentBytes + bytes > TRANSCRIPT_TAIL_RESIDENT_BYTES) return undefined;
	try {
		return staging.stage(TAIL_KIND, protocolId(`entry-${index}`), text);
	} catch (cause) {
		if (cause instanceof TransferStagingError) return undefined;
		throw cause;
	}
}

/**
 * The internal bootstrap reader (S12a): stages the text of every entry a bootstrap carries, in bounded fragments,
 * before the epoch publishes any of it. One refusal releases everything already staged and refuses the bootstrap
 * whole (undefined), so no partial transcript exists; the caller abandons whatever it does not adopt.
 */
export function stageBootstrap(
	staging: TransferStaging,
	transitions: readonly TranscriptTransition[],
): Map<TranscriptTransition, StagedContent> | undefined {
	const staged = new Map<TranscriptTransition, StagedContent>();
	let index = 0;
	try {
		for (const transition of transitions) {
			if (transition.kind === "replace") index = 0;
			if (transition.kind !== "append") continue;
			const text = transition.entry;
			const content = text === undefined ? null : stageTailEntry(staging, new TailBudget(), index, text);
			index += 1;
			if (content === undefined) throw new TransferStagingError("staging_over_byte_limit");
			if (content) staged.set(transition, content);
		}
		return staged;
	} catch (cause) {
		for (const content of staged.values()) staging.release(content);
		if (cause instanceof TransferStagingError) return undefined;
		throw cause;
	}
}

/** What a read by identity of a tail entry can fail with (RULING-78 (2)), never returning other bytes. */
export type TailReadFailure = "transcript_segment_missing" | "transcript_segment_mismatch";

/**
 * A reader's consistent cut of one tail: the first `fileCount` entries come from the file through its identity, every
 * later one from its own segments, pinned until `release`.
 */
export interface TailHold {
	readonly fileCount: number;
	readonly persistence: TranscriptPersistence | null;
	has(index: number): boolean;
	chunks(index: number, valid?: () => void): AsyncGenerator<string>;
	release(): void;
}

/**
 * The unpersisted entries of one epoch as staged content in the lane's store, shared by every root frozen from it: a
 * persistence report releases the entries it covers from the tail, held cuts included (RULING-21 (4)), and moves them
 * to the spool. An entry a live cut still names stays there, `kept`, until the last such cut is released (RULING-78
 * (1)): a held cut reads its own segments, whatever later happens to the file. Persistence never changes a count.
 */
export class TranscriptTail {
	readonly entries = new Map<number, StagedContent>();
	readonly kept = new Map<number, StagedContent>();
	retainedBytes = 0;
	persistence: TranscriptPersistence | null;
	readonly #staging: TransferStaging;
	readonly #budget: TailBudget;
	/** Live cuts by their entry count: a cut of count `n` names every entry below `n`. */
	readonly #cuts = new Map<number, number>();
	#superseded = false;

	constructor(staging: TransferStaging, persistence: TranscriptPersistence | null, budget = new TailBudget()) {
		this.#staging = staging;
		this.persistence = persistence;
		this.#budget = budget;
	}

	stage(index: number, text: string): StagedContent | undefined {
		return stageTailEntry(this.#staging, this.#budget, index, text);
	}

	adopt(index: number, content: StagedContent): void {
		this.#staging.adopt(content);
		this.entries.set(index, content);
		this.retainedBytes += content.ref.entry.length;
		this.#budget.held += content.ref.entry.length;
	}

	retainCut(count: number): void {
		this.#cuts.set(count, (this.#cuts.get(count) ?? 0) + 1);
	}

	/**
	 * A `replace` within the epoch left this tail behind: released now unless a live cut still names it, else by the last
	 * such cut's release, so a replaced version still reads its own entries (RULING-78 (1), C1.1).
	 */
	supersede(): void {
		this.#superseded = true;
		if (this.#cuts.size === 0) return this.releaseAll();
		// No later persistence reaches a superseded tail: its unpersisted entries leave RAM now, still readable, so they
		// never take the resident room the next version appends into (carry 66).
		for (const content of this.entries.values()) this.#staging.spill(content);
	}

	/** The last live cut naming a kept entry releases its segments; the last cut of a superseded tail releases it all. */
	releaseCut(count: number): void {
		const left = (this.#cuts.get(count) ?? 0) - 1;
		if (left > 0) this.#cuts.set(count, left);
		else this.#cuts.delete(count);
		if (this.#superseded && this.#cuts.size === 0) return this.releaseAll();
		const reach = this.reach();
		for (const [index, content] of this.kept) {
			if (index < reach) continue;
			this.kept.delete(index);
			this.free(content);
		}
	}

	/** `baseCount` entries precede this tail's index 0 in the file. */
	persisted(persistence: TranscriptPersistence, baseCount: number): void {
		this.persistence = persistence;
		const reach = this.reach();
		for (const [index, content] of this.entries) {
			if (index + baseCount >= persistence.count) break;
			this.entries.delete(index);
			this.retainedBytes -= content.ref.entry.length;
			if (index >= reach) {
				this.free(content);
				continue;
			}
			this.kept.set(index, content);
			this.#staging.spill(content);
		}
	}

	releaseAll(): void {
		for (const content of [...this.entries.values(), ...this.kept.values()]) this.free(content);
		this.entries.clear();
		this.kept.clear();
		this.retainedBytes = 0;
	}

	hold(count: number, baseCount: number): TailHold {
		const staging = this.#staging;
		const own = (index: number) => this.entries.get(index) ?? this.kept.get(index);
		let fileCount = Math.min(count, Math.max(0, (this.persistence?.count ?? 0) - baseCount));
		while (fileCount > 0 && own(fileCount - 1)) fileCount -= 1;
		const held = new Map<number, StagedContent>();
		for (let index = fileCount; index < count; index++) {
			const content = own(index);
			if (content) held.set(index, content);
		}
		for (const content of held.values()) staging.pin(content, 1);
		let released = false;
		return {
			fileCount,
			persistence: this.persistence,
			has: (index) => held.has(index),
			chunks: (index, valid) => {
				const content = held.get(index);
				if (!content) throw new RangeError(`transcript tail entry ${index} is not held`);
				return staging.chunks(content, valid);
			},
			release: () => {
				if (released) return;
				released = true;
				for (const content of held.values()) staging.pin(content, -1);
			},
		};
	}

	/** Content leaves the store and the bound together: kept segments stay counted until exactly this release. */
	private free(content: StagedContent): void {
		this.#budget.held -= content.ref.entry.length;
		this.#staging.release(content);
	}

	private reach(): number {
		let reach = 0;
		for (const count of this.#cuts.keys()) reach = Math.max(reach, count);
		return reach;
	}
}
