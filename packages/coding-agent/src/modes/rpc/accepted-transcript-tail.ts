import type { TranscriptPersistence, TranscriptTransition } from "../../core/session-transcript-journal.ts";
import { protocolId } from "./compact-recovery-ids.ts";
import { type StagedContent, type TransferStaging, TransferStagingError } from "./compact-transfer-staging.ts";

/**
 * Accepted tail bytes one epoch may hold beyond its persisted count, resident and spilled together, in stored
 * UTF-16LE bytes (RULING-21 (3)). The tail spills to the lane's staging store (S12a), so this bounds the spool a
 * writer that stopped persisting can grow, not RAM: sixteen times the 16 MiB in-memory tail it replaces.
 */
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 256 * 1024 * 1024;
/**
 * Tail bytes the staging store may hold in RAM, unspilled, when an entry is staged: what bounds memory when the spool
 * lags or failed. Never below the 16 MiB of UTF-8 the old tail allowed, as UTF-16 stores at most two bytes per byte.
 */
export const TRANSCRIPT_TAIL_RESIDENT_BYTES = 32 * 1024 * 1024;
const TAIL_KIND = protocolId("transcript-tail");

/**
 * Stages one accepted entry's text against both tail bounds, `retained` being the bytes its tail already adopted;
 * undefined, with nothing allocated, when a bound refuses it.
 */
function stageTailEntry(
	staging: TransferStaging,
	retained: number,
	index: number,
	text: string,
): StagedContent | undefined {
	const bytes = text.length * 2;
	if (retained + staging.stagedBytes + bytes > DEFAULT_TRANSCRIPT_TAIL_BYTES) return undefined;
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
			const content = text === undefined ? null : stageTailEntry(staging, 0, index, text);
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

/** A reader's consistent cut of one tail: what the file covers, and pins on every tail entry after it. */
export interface TailHold {
	readonly persistedCount: number;
	readonly persistence: TranscriptPersistence | null;
	has(index: number): boolean;
	chunks(index: number, valid?: () => void): AsyncGenerator<string>;
	release(): void;
}

/**
 * The unpersisted entries of one epoch as staged content in the lane's store, shared by every root frozen from it: a
 * persistence report releases the entries it covers, held cuts included (RULING-21 (4)); only a reader's hold keeps
 * their leaves until it ends. Persistence moves the source of those exact entries, never the accepted count.
 */
export class TranscriptTail {
	readonly entries = new Map<number, StagedContent>();
	retainedBytes = 0;
	persistence: TranscriptPersistence | null;
	readonly #staging: TransferStaging;

	constructor(staging: TransferStaging, persistence: TranscriptPersistence | null) {
		this.#staging = staging;
		this.persistence = persistence;
	}

	stage(index: number, text: string): StagedContent | undefined {
		return stageTailEntry(this.#staging, this.retainedBytes, index, text);
	}

	adopt(index: number, content: StagedContent): void {
		this.#staging.adopt(content);
		this.entries.set(index, content);
		this.retainedBytes += content.ref.entry.length;
	}

	/** `baseCount` entries precede this tail's index 0 in the file. */
	persisted(persistence: TranscriptPersistence, baseCount: number): void {
		this.persistence = persistence;
		for (const [index, content] of this.entries) {
			if (index + baseCount >= persistence.count) break;
			this.drop(index, content);
		}
	}

	releaseAll(): void {
		for (const [index, content] of this.entries) this.drop(index, content);
	}

	hold(count: number, baseCount: number): TailHold {
		const staging = this.#staging;
		const persistedCount = Math.min(count, Math.max(0, (this.persistence?.count ?? 0) - baseCount));
		const held = new Map<number, StagedContent>();
		for (let index = persistedCount; index < count; index++) {
			const content = this.entries.get(index);
			if (content) held.set(index, content);
		}
		for (const content of held.values()) staging.pin(content, 1);
		let released = false;
		return {
			persistedCount,
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

	private drop(index: number, content: StagedContent): void {
		this.entries.delete(index);
		this.retainedBytes -= content.ref.entry.length;
		this.#staging.release(content);
	}
}
