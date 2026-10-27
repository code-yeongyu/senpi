import { CompactColdOperations } from "./compact-cold-operations.ts";
import { CompactComponentRoots } from "./compact-component-roots.ts";
import { CompactContentIndex } from "./compact-content-index.ts";
import { CompactContentStore, type CompactContentStoreOptions } from "./compact-content-store.ts";
import { seededBlockLeaves } from "./compact-seeded-block.ts";
import type { MessageRoot, SettledRow } from "./compact-state-view.ts";
import type { FrozenBlock } from "./compact-text-view.ts";

export interface CompactSessionStateOptions extends CompactContentStoreOptions {
	readonly compactAboveRows?: number;
}

/** Constructs the single storage graph shared by acceptance, settlement, and frozen reads. */
export class CompactStateStorage {
	protected readonly store: CompactContentStore;
	protected readonly settled: CompactContentIndex<SettledRow>;
	protected readonly cold: CompactColdOperations;
	protected readonly blockRoots: CompactComponentRoots<FrozenBlock>;
	protected readonly messageRoots: CompactComponentRoots<MessageRoot>;

	constructor(options: CompactSessionStateOptions) {
		this.store = new CompactContentStore(options);
		this.blockRoots = new CompactComponentRoots(this.store, (block) => [
			block.root,
			block.tailRoot ?? 0,
			...(block.seeded ? seededBlockLeaves(block.seeded) : []),
		]);
		this.messageRoots = new CompactComponentRoots(this.store, (row) => [row.blocks?.owner ?? 0]);
		this.settled = new CompactContentIndex(
			this.store,
			(row) => [row.blocks?.owner ?? 0],
			options.compactAboveRows ?? 128,
		);
		this.cold = new CompactColdOperations(this.settled, (key) => this.isActiveKey(key));
	}

	/** Whether a message is still live in acceptance; cold operations re-check this at apply time. */
	protected isActiveKey(_key: string): boolean {
		return false;
	}
}
