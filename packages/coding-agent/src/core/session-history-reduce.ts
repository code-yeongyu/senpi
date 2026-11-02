import type { SessionEntry } from "./session-manager.ts";

/**
 * A fold over a session's whole history, in append order (senpi#2537).
 *
 * Per-turn readers that only need "the latest X" or "everything since the last Y" used to call `getEntries()`.
 * On a compacted session that builds and keeps a full-history view of the file, and a stream that never settles
 * idle never released it. A reducer instead keeps only its own state: the history is read once per session load,
 * and every later call folds just the entries appended since.
 *
 * The reducer must be a stable (module-level) object, because its state is memoized per reducer. `add` may update
 * the state in place; callers must treat the returned state as read-only. A reducer must not rely on `parentId`: an
 * entry kept across a compaction can arrive with its link to the trimmed part rewritten, as `getEntries()` shows it.
 */
export interface HistoryReducer<S> {
	readonly initial: () => S;
	readonly add: (state: S, entry: SessionEntry) => S;
}

export interface HistorySource {
	/** Changes whenever the history is replaced (new session, file load, reload); never on append or mirror trim. */
	readonly generation: () => number;
	/** Entries in the whole history, including any a trim left only on disk. */
	readonly count: () => number;
	/** The entries appended after the first `count`, or undefined when the mirror cannot supply them. */
	readonly appendedSince: (count: number) => readonly SessionEntry[] | undefined;
	/** The whole history, materialized for this one read and not kept. */
	readonly readAll: () => readonly SessionEntry[];
}

interface Reduction {
	readonly generation: number;
	readonly count: number;
	readonly state: unknown;
}

export class HistoryReductions {
	private readonly source: HistorySource;
	private reductions = new WeakMap<object, Reduction>();

	constructor(source: HistorySource) {
		this.source = source;
	}

	reduce<S>(reducer: HistoryReducer<S>): S {
		const generation = this.source.generation();
		const count = this.source.count();
		const previous = this.reductions.get(reducer);
		if (previous !== undefined && previous.generation === generation && previous.count <= count) {
			// The state was produced by this reducer, so it has type S.
			const state = previous.state as S;
			if (previous.count === count) return state;
			const appended = this.source.appendedSince(previous.count);
			if (appended !== undefined) return this.store(reducer, generation, count, this.fold(reducer, state, appended));
		}
		return this.store(reducer, generation, count, this.fold(reducer, reducer.initial(), this.source.readAll()));
	}

	/** A fold that throws may have updated the memoized state in place, so the memo goes and the next call starts over. */
	private fold<S>(reducer: HistoryReducer<S>, initial: S, entries: readonly SessionEntry[]): S {
		try {
			let state = initial;
			for (const entry of entries) state = reducer.add(state, entry);
			return state;
		} catch (error) {
			this.reductions.delete(reducer);
			throw error;
		}
	}

	private store<S>(reducer: HistoryReducer<S>, generation: number, count: number, state: S): S {
		this.reductions.set(reducer, { generation, count, state });
		return state;
	}
}
