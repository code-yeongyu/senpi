import type { CompactContentIndex, FrozenIndex, IndexRow } from "./compact-content-index.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { SeededMessage } from "./compact-seeded-messages.ts";
import type { SettledRow } from "./compact-state-view.ts";
import type { CompactPersistence, CompactTransition } from "./compact-transition.ts";

export type CompactColdOperation =
	| Extract<CompactTransition, { type: "message_status" | "message_remove" }>
	/** Old-message edit: the settled row's content is replaced whole; persistence and correlation are kept. */
	| { readonly type: "message_replace"; readonly messageId: string; readonly message: SeededMessage }
	/** Branch replacement: the row is installed whole, present or not, with the replacement's persistence. */
	| {
			readonly type: "message_install";
			readonly messageId: string;
			readonly message: SeededMessage;
			readonly persistence: CompactPersistence;
	  };
export type CompactColdOutcome =
	| { readonly kind: "applied"; readonly afterSequence: number }
	| {
			readonly kind: "rejected";
			readonly afterSequence: number;
			readonly reason: "unknown_message" | "active_message" | "capacity" | "retired";
	  }
	| { readonly kind: "failed"; readonly afterSequence: number; readonly cause: unknown };

type Index = Pick<
	CompactContentIndex<SettledRow>,
	"store" | "values" | "overlays" | "freeze" | "lookup" | "patch" | "delete" | "release"
>;
type Keep = Pick<SettledRow, "persistence" | "correlation">;
type Install = (messageId: string, message: SeededMessage, keep: Keep) => void;
interface Token {
	removed: boolean;
	active: boolean;
	pending: number;
}
type Step = () => Promise<CompactColdOutcome>;

/** Non-acceptance FIFO. Capacity rejection leaves work unqueued; callers await admitted operations. */
export class CompactColdOperations {
	private chain: Promise<void> = Promise.resolve();
	private readonly keys = new Map<string, Token>();
	private pending = 0;
	private readonly index: Index;
	private readonly isActive: (key: string) => boolean;
	private readonly install: Install;
	constructor(index: Index, isActive: (key: string) => boolean, install: Install) {
		this.index = index;
		this.isActive = isActive;
		this.install = install;
	}

	activate(key: string): void {
		const token = this.keys.get(key);
		if (token) token.active = true;
	}

	run(input: CompactColdOperation, afterSequence: number): Promise<CompactColdOutcome> {
		if (this.isActive(input.messageId)) return Promise.resolve(this.active(afterSequence));
		// Bound queued roots, keys and closures independently of the settled membership catalog.
		if (this.pending === 128) return Promise.resolve({ kind: "rejected", reason: "capacity", afterSequence });
		return this.enqueue(this.admit(input, afterSequence));
	}

	/** One FIFO unit holding one capacity slot; each operation keeps its order and its own typed outcome. */
	runAll(inputs: readonly CompactColdOperation[], afterSequence: number): Promise<readonly CompactColdOutcome[]> {
		const capacity = { kind: "rejected", reason: "capacity", afterSequence } as const;
		if (this.pending === 128) return Promise.resolve(inputs.map(() => capacity));
		const steps = inputs.map((input): Step => {
			if (!this.isActive(input.messageId)) return this.admit(input, afterSequence);
			return async () => this.active(afterSequence);
		});
		return this.enqueue(async () => {
			const outcomes: CompactColdOutcome[] = [];
			for (const step of steps) outcomes.push(await step());
			return outcomes;
		});
	}

	idle(): Promise<void> {
		return this.chain;
	}

	private active(afterSequence: number): CompactColdOutcome {
		return { kind: "rejected", reason: "active_message", afterSequence };
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pending++;
		const result = this.chain.then(task).finally(() => {
			this.pending--;
		});
		this.chain = result.then(() => undefined);
		return result;
	}

	private admit(input: CompactColdOperation, afterSequence: number): Step {
		const operation = { ...input };
		const key = operation.messageId;
		const previous = this.keys.get(key);
		const token = (previous?.active ? undefined : previous) ?? { removed: false, active: false, pending: 0 };
		this.keys.set(key, token);
		token.pending++;
		return async () => {
			try {
				return await this.apply(operation, token, afterSequence);
			} finally {
				if (--token.pending === 0 && this.keys.get(key) === token) this.keys.delete(key);
			}
		};
	}

	private async apply(
		operation: CompactColdOperation,
		token: Token,
		afterSequence: number,
	): Promise<CompactColdOutcome> {
		const key = operation.messageId;
		const unknown = { kind: "rejected", reason: "unknown_message", afterSequence } as const;
		try {
			this.index.store.assertReadable();
			if (token.active || this.isActive(key)) return this.active(afterSequence);
			if (token.removed && operation.type !== "message_install") return unknown;
			const cut = this.index.freeze();
			try {
				const row = await this.index.lookup(cut, key);
				const keep =
					operation.type === "message_install"
						? { persistence: operation.persistence }
						: row && operation.type === "message_replace"
							? await this.current(cut, key, row)
							: undefined;
				this.index.store.assertReadable();
				if (token.active || this.isActive(key)) return this.active(afterSequence);
				if (!row && !keep) return unknown;
				switch (operation.type) {
					case "message_status":
						this.index.patch(key, { persistence: operation.persistence });
						break;
					case "message_remove":
						this.index.delete(key);
						token.removed = true;
						this.keys.delete(key);
						break;
					default:
						if (keep) this.install(key, operation.message, keep);
				}
				return { kind: "applied", afterSequence };
			} finally {
				this.index.release(cut);
			}
		} catch (cause) {
			return cause instanceof CompactReadError && cause.reason === "retired"
				? { kind: "rejected", reason: "retired", afterSequence }
				: { kind: "failed", cause, afterSequence };
		}
	}

	/** The row as a reader sees it at the cut: its stored value plus any pending field patch. */
	private async current(cut: FrozenIndex, key: string, row: IndexRow): Promise<Keep> {
		const value: SettledRow = JSON.parse(JSON.stringify(await this.index.values.read(row.value)));
		const patch = this.index.overlays.get(cut.overrides, key)?.patchValue;
		if (patch) Object.assign(value, await this.index.values.read(patch));
		return { persistence: value.persistence, ...(value.correlation ? { correlation: value.correlation } : {}) };
	}
}
