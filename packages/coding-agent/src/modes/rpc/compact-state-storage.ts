import { CompactColdOperations } from "./compact-cold-operations.ts";
import { CompactComponentRoots } from "./compact-component-roots.ts";
import { CompactContentIndex } from "./compact-content-index.ts";
import { CompactContentStore, type CompactContentStoreOptions } from "./compact-content-store.ts";
import { seededBlockLeaves } from "./compact-seeded-block.ts";
import { installSettledMessage } from "./compact-seeded-messages.ts";
import type { MessageRoot, SettledRow } from "./compact-state-view.ts";
import type { FrozenBlock } from "./compact-text-view.ts";

const messageLeaves = (row: MessageRoot) => [
	row.blocks?.owner ?? 0,
	...Object.values({ ...row.fields, ...row.correlation }).map((ref) => ref.owner),
];

export interface CompactSessionStateOptions extends CompactContentStoreOptions {
	readonly compactAboveRows?: number;
	/** The registry nonce of the epoch this owner serves; the only epoch it accepts (RULING-39). */
	readonly epoch?: string;
	/** The lane's accepted-sequence epoch, the prefix of every runtime item key it mints (RULING-13 Q1). */
	readonly sessionEpoch?: string;
}

/** Constructs the single storage graph shared by acceptance, settlement, and frozen reads. */
export class CompactStateStorage {
	protected readonly store: CompactContentStore;
	protected readonly settled: CompactContentIndex<SettledRow>;
	protected readonly cold: CompactColdOperations;
	protected readonly blockRoots: CompactComponentRoots<FrozenBlock>;
	protected readonly messageRoots: CompactComponentRoots<MessageRoot>;
	protected readonly epoch: string | undefined;
	protected readonly sessionEpoch: string;

	constructor(options: CompactSessionStateOptions) {
		this.epoch = options.epoch;
		this.sessionEpoch = options.sessionEpoch ?? "";
		this.store = new CompactContentStore(options);
		this.blockRoots = new CompactComponentRoots(this.store, (block) => [
			block.root,
			block.tailRoot ?? 0,
			...(block.seeded ? seededBlockLeaves(block.seeded) : []),
		]);
		this.messageRoots = new CompactComponentRoots(this.store, messageLeaves);
		this.settled = new CompactContentIndex<SettledRow>(this.store, messageLeaves, options.compactAboveRows ?? 128);
		this.cold = new CompactColdOperations(
			this.settled,
			(key) => this.isActiveKey(key),
			(messageId, message, keep) =>
				installSettledMessage(
					{ store: this.store, blockRoots: this.blockRoots, settled: this.settled },
					messageId,
					message,
					keep,
				),
		);
	}

	/** Whether a message is still live in acceptance; cold operations re-check this at apply time. */
	protected isActiveKey(_key: string): boolean {
		return false;
	}
}
