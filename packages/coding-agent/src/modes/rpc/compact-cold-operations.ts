import type { CompactContentIndex } from "./compact-content-index.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { CompactPersistence, CompactTransition } from "./compact-transition.ts";

export type CompactColdOperation = Extract<CompactTransition, { type: "message_status" | "message_remove" }>;
export type CompactColdOutcome =
	| { readonly kind: "applied"; readonly afterSequence: number }
	| {
			readonly kind: "rejected";
			readonly afterSequence: number;
			readonly reason: "unknown_message" | "active_message" | "capacity" | "retired";
	  }
	| { readonly kind: "failed"; readonly afterSequence: number; readonly cause: unknown };

type Index = Pick<
	CompactContentIndex<{ readonly persistence: CompactPersistence }>,
	"store" | "freeze" | "lookup" | "patch" | "delete" | "release"
>;
/** Non-acceptance FIFO. Capacity rejection leaves work unqueued; callers await admitted operations. */
export class CompactColdOperations {
	private chain: Promise<void> = Promise.resolve();
	private readonly keys = new Map<string, { removed: boolean; active: boolean; pending: number }>();
	private pending = 0;
	private readonly index: Index;
	private readonly isActive: (key: string) => boolean;
	constructor(index: Index, isActive: (key: string) => boolean) {
		this.index = index;
		this.isActive = isActive;
	}

	activate(key: string): void {
		const token = this.keys.get(key);
		if (token) token.active = true;
	}

	run(input: CompactColdOperation, afterSequence: number): Promise<CompactColdOutcome> {
		const operation = { ...input };
		const key = operation.messageId;
		if (this.isActive(key)) return Promise.resolve({ kind: "rejected", reason: "active_message", afterSequence });
		// Bound queued roots, keys and closures independently of the settled membership catalog.
		if (this.pending === 128) return Promise.resolve({ kind: "rejected", reason: "capacity", afterSequence });
		const previous = this.keys.get(key);
		const token = (previous?.active ? undefined : previous) ?? { removed: false, active: false, pending: 0 };
		this.keys.set(key, token);
		token.pending++;
		this.pending++;
		const result = this.chain.then(async (): Promise<CompactColdOutcome> => {
			try {
				this.index.store.assertReadable();
				if (token.active || this.isActive(key))
					return { kind: "rejected", reason: "active_message", afterSequence };
				if (token.removed) return { kind: "rejected", reason: "unknown_message", afterSequence };
				const cut = this.index.freeze();
				try {
					const row = await this.index.lookup(cut, key);
					this.index.store.assertReadable();
					if (token.active || this.isActive(key))
						return { kind: "rejected", reason: "active_message", afterSequence };
					if (!row) return { kind: "rejected", reason: "unknown_message", afterSequence };
					if (operation.type === "message_status") this.index.patch(key, { persistence: operation.persistence });
					else {
						this.index.delete(key);
						token.removed = true;
						this.keys.delete(key);
					}
					return { kind: "applied", afterSequence };
				} finally {
					this.index.release(cut);
				}
			} catch (cause) {
				return cause instanceof CompactReadError && cause.reason === "retired"
					? { kind: "rejected", reason: "retired", afterSequence }
					: { kind: "failed", cause, afterSequence };
			} finally {
				this.pending--;
				if (--token.pending === 0 && this.keys.get(key) === token) this.keys.delete(key);
			}
		});
		this.chain = result.then(() => undefined);
		return result;
	}

	idle(): Promise<void> {
		return this.chain;
	}
}
