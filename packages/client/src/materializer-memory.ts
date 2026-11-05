import {
	type MaterializerAdapter,
	type MaterializerIdentity,
	type MaterializerTransaction,
	type MaterializerUnit,
	type MaterializerSnapshot,
	MaterializerRefusal,
} from "./materializer.ts";

interface MemorySession {
	generation: number;
	readonly committed: Map<number, MaterializerSnapshot>;
	abort?: () => void;
}
const sessionKey = (key: MaterializerIdentity) => JSON.stringify([key.sessionId, key.sessionEpoch]);

/** Reference adapter only: restart preserves committed memory, not process/disk durability.
 * SQL adapters provide real durability and run the same exported conformance kit.
 */
export class MemoryMaterializerAdapter<T = unknown> implements MaterializerAdapter<T> {
	private readonly sessions: Map<string, MemorySession>;
	private stopped = false;
	/** Fault hooks for conformance; beforeCommit runs exactly after apply and before atomic publication. */
	beforeCommit?: (unit: MaterializerUnit<T>) => void | Promise<void>;
	beforeEffect?: (effect: unknown, index: number) => void | Promise<void>;

	constructor(sessions = new Map<string, MemorySession>()) {
		this.sessions = sessions;
	}

	private assertLive(): void {
		if (this.stopped) throw new MaterializerRefusal("aborted");
	}

	async reset(key: MaterializerIdentity): Promise<void> {
		this.assertLive();
		const id = sessionKey(key);
		const state = this.sessions.get(id);
		if (state && key.generation < state.generation) throw new MaterializerRefusal("stale_generation");
		if (state?.generation === key.generation) return;
		state?.abort?.();
		this.sessions.set(id, { generation: key.generation, committed: state?.committed ?? new Map() });
	}

	snapshot(key: MaterializerIdentity): MaterializerSnapshot {
		return structuredClone(
			this.sessions.get(sessionKey(key))?.committed.get(key.generation) ?? { frontier: 0, effects: [] },
		);
	}

	async frontier(key: MaterializerIdentity): Promise<number> {
		return this.snapshot(key).frontier;
	}

	async begin(key: MaterializerIdentity): Promise<MaterializerTransaction<T>> {
		this.assertLive();
		const state = this.sessions.get(sessionKey(key));
		if (!state || state.generation !== key.generation) throw new MaterializerRefusal("stale_generation");
		if (state.abort) throw new MaterializerRefusal("in_flight");
		let live = true;
		let staged: MaterializerUnit<T> | undefined;
		let effects: unknown[] = [];
		const abort = () => {
			live = false;
			staged = undefined;
			effects = [];
			if (state.abort === abort) state.abort = undefined;
		};
		const assert = () => {
			this.assertLive();
			if (!live || this.sessions.get(sessionKey(key)) !== state) throw new MaterializerRefusal("aborted");
		};
		state.abort = abort;
		return {
			apply: async (unit) => {
				try {
					assert();
					if (staged || sessionKey(unit) !== sessionKey(key) || unit.generation !== key.generation)
						throw new MaterializerRefusal("invalid_unit");
					for (const [index, effect] of [...unit.controls, unit.record].entries()) {
						await this.beforeEffect?.(effect, index);
						assert();
						effects.push(structuredClone(effect));
					}
					staged = unit;
				} catch (cause) {
					abort();
					throw cause;
				}
			},
			commit: async (sequence) => {
				const previous = this.snapshot(key);
				if (sequence <= previous.frontier) {
					abort();
					return "duplicate";
				}
				assert();
				if (!staged || staged.sequence !== sequence) {
					abort();
					throw new MaterializerRefusal("invalid_unit");
				}
				try {
					await this.beforeCommit?.(staged);
					assert();
					// ONE publication point: readers can observe neither frontier-only nor effects-only.
					state.committed.set(key.generation, { frontier: sequence, effects: [...previous.effects, ...effects] });
					abort();
					return "applied";
				} catch (cause) {
					abort();
					throw cause;
				}
			},
			abort: async () => abort(),
		};
	}

	/** Crash discards private transactions; a fresh adapter opens the exact last committed store. */
	restart(): MemoryMaterializerAdapter<T> {
		for (const state of this.sessions.values()) state.abort?.();
		this.stopped = true;
		return new MemoryMaterializerAdapter<T>(this.sessions);
	}
}
