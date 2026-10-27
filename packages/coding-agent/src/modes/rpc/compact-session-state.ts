import { type ActiveBlock, type ActiveMessage, adjustBlock, appendBlock, deltaBlock } from "./compact-active-block.ts";
import { CompactComponentRoots, type ComponentRoot } from "./compact-component-roots.ts";
import { CompactColdOperations, type CompactColdOperation } from "./compact-cold-operations.ts";
import { CompactContentIndex } from "./compact-content-index.ts";
import { CompactContentStore, type CompactContentStoreOptions } from "./compact-content-store.ts";
import { CompactReadError, CompactReadLease } from "./compact-read-lease.ts";
import { CompactStartIdentity } from "./compact-start-identity.ts";
import { type FrozenCompactState, type MessageRoot, type SettledRow, readCompactState } from "./compact-state-view.ts";
import type { FrozenBlock } from "./compact-text-view.ts";
import { type BlockAddress, type CompactTransition, CompactTransitionError } from "./compact-transition.ts";
export interface CompactSessionStateOptions extends CompactContentStoreOptions {
	readonly compactAboveRows?: number;
}

/** Synchronous acceptance; cuts and settlement transfer persistent component roots (senpi#4272). */
export class CompactSessionState {
	private readonly store: CompactContentStore;
	private readonly settled: CompactContentIndex<SettledRow>;
	private readonly cold: CompactColdOperations;
	private readonly blockRoots: CompactComponentRoots<FrozenBlock>;
	private readonly messageRoots: CompactComponentRoots<MessageRoot>;
	private messages: ComponentRoot<MessageRoot> = { header: undefined, ref: undefined };
	private readonly active = new Map<string, ActiveMessage>();
	private readonly identity = new CompactStartIdentity();
	private sequence = 0;
	private residentTailBytes = 0;
	private hotWitnessBytes = 0;
	private frozenTailBytes = 0;
	private readonly cuts = new WeakMap<FrozenCompactState, CompactReadLease>();

	constructor(options: CompactSessionStateOptions) {
		this.store = new CompactContentStore(options);
		this.blockRoots = new CompactComponentRoots(this.store, (block) => [block.root, block.tailRoot ?? 0]);
		this.messageRoots = new CompactComponentRoots(this.store, (row) => [row.blocks?.owner ?? 0]);
		this.settled = new CompactContentIndex(
			this.store,
			(row) => [row.blocks?.owner ?? 0],
			options.compactAboveRows ?? 128,
		);
		this.cold = new CompactColdOperations(this.settled, (key) => this.active.has(key));
	}

	get acceptedSequence(): number {
		return this.sequence;
	}

	accept(t: CompactTransition): number {
		if (t.type !== "message_remove") this.store.assertReadable();
		if ((t.type === "message_status" || t.type === "message_remove") && !this.active.has(t.messageId))
			throw new CompactTransitionError("cold_operation_required", "use applyCold after acceptance");
		switch (t.type) {
			case "block_start":
				this.start(t);
				break;
			case "block_delta": {
				const block = { ...this.block(t) };
				adjustBlock(this.store, block, 1);
				try {
					deltaBlock(this.store, block, t.offset, t.text);
					this.publish(t, block);
				} finally {
					adjustBlock(this.store, block, -1);
				}
				break;
			}
			case "block_replace": {
				const block: ActiveBlock = {
					...this.block(t),
					root: 0,
					tail: "",
					tailRoot: 0,
					units: 0,
					covered: 0,
					witness: "",
				};
				appendBlock(this.store, block, t.text);
				block.emitted = block.units;
				this.publish(t, block);
				adjustBlock(this.store, block, -1);
				break;
			}
			case "message_status":
				this.settled.set(t.messageId, {
					messageId: t.messageId,
					persistence: t.persistence,
					blocks: this.active.get(t.messageId)?.root.ref,
				});
				this.dropActive(t.messageId);
				break;
			case "message_remove":
				this.dropActive(t.messageId);
				break;
		}
		return ++this.sequence;
	}

	applyCold(t: CompactColdOperation) {
		return this.cold.run(t, this.sequence);
	}

	freeze(): FrozenCompactState {
		this.store.assertReadable();
		const active = this.messages.ref;
		const tails = this.residentTailBytes;
		if (active) this.store.adjust(active.owner, 0, 1);
		this.frozenTailBytes += tails;
		const frozen = { sequence: this.sequence, active, settled: this.settled.freeze() };
		this.cuts.set(
			frozen,
			new CompactReadLease(() => {
				if (active) this.store.adjust(active.owner, 0, -1);
				this.frozenTailBytes -= tails;
				this.settled.release(frozen.settled);
			}),
		);
		return frozen;
	}

	release(frozen: FrozenCompactState): void {
		this.cutLease(frozen).release();
	}

	/** Whole-view compatibility assembly; persistent nodes and text ranges are read separately. */
	async read(frozen: FrozenCompactState) {
		const lease = this.cutLease(frozen);
		const valid = () => {
			lease.assert();
			this.store.assertReadable();
		};
		valid();
		return lease.run(() =>
			readCompactState(
				frozen,
				{
					store: this.store,
					settled: this.settled,
					blockRoots: this.blockRoots,
					messageRoots: this.messageRoots,
				},
				valid,
			),
		);
	}

	private cutLease(frozen: FrozenCompactState): CompactReadLease {
		const lease = this.cuts.get(frozen);
		if (!lease) throw new CompactReadError("ownership");
		return lease;
	}

	storageStatus() {
		return {
			...this.store.status(),
			...this.settled.status(),
			residentTailBytes: this.residentTailBytes,
			frozenTailBytes: this.frozenTailBytes,
			hotWitnessBytes: this.hotWitnessBytes,
			residentComponentNodes: this.blockRoots.residentNodes + this.messageRoots.residentNodes,
			residentComponentIndexBytes: (this.blockRoots.residentNodes + this.messageRoots.residentNodes) * 192,
			residentTextNodes: this.store.text.residentNodes,
			residentTextIndexBytes: this.store.text.residentNodes * 192,
		};
	}

	async idle(): Promise<void> {
		await this.cold.idle();
		await this.store.idle();
	}

	async retire(): Promise<void> {
		await this.store.retire();
		await this.cold.idle();
	}

	private start(t: Extract<CompactTransition, { type: "block_start" }>): void {
		this.identity.validate(t);
		if (this.active.get(t.messageId)?.blocks.has(t.contentIndex))
			throw new CompactTransitionError("duplicate_block", `${t.messageId}#${t.contentIndex}`);
		const covered = t.coveredCodeUnits;
		if (!Number.isInteger(covered) || (covered !== 0 && covered !== t.seed.length))
			throw new CompactTransitionError("invalid_coverage", `${covered} of ${t.seed.length} seed code units`);
		const block: ActiveBlock = {
			kind: t.kind,
			root: 0,
			tail: "",
			tailRoot: 0,
			units: 0,
			emitted: covered > 0 ? 0 : t.seed.length,
			covered,
			witness: t.seed.slice(0, covered),
		};
		appendBlock(this.store, block, t.seed);
		this.publish(t, block);
		adjustBlock(this.store, block, -1);
		this.identity.commit(t);
		this.cold.activate(t.messageId);
	}

	private publish(address: BlockAddress, block: ActiveBlock): void {
		const message = this.active.get(address.messageId) ?? {
			order: String(this.sequence).padStart(16, "0"),
			blocks: new Map<number, ActiveBlock>(),
			root: { header: undefined, ref: undefined },
			tailBytes: 0,
			witnessBytes: 0,
		};
		const old = message.blocks.get(address.contentIndex);
		const tails = (block.tail.length - (old?.tail.length ?? 0)) * 2;
		const witness = (block.witness.length - (old?.witness.length ?? 0)) * 2;
		message.root = this.blockRoots.set(message.root, String(address.contentIndex).padStart(16, "0"), {
			contentIndex: address.contentIndex,
			kind: block.kind,
			root: block.root,
			tail: "",
			tailRoot: block.tailRoot,
		});
		this.messages = this.messageRoots.set(this.messages, message.order, {
			messageId: address.messageId,
			blocks: message.root.ref,
		});
		message.blocks.set(address.contentIndex, block);
		message.tailBytes += tails;
		message.witnessBytes += witness;
		this.residentTailBytes += tails;
		this.hotWitnessBytes += witness;
		this.active.set(address.messageId, message);
	}

	private dropActive(messageId: string): void {
		const message = this.active.get(messageId);
		if (!message) return;
		this.messages = this.messageRoots.set(this.messages, message.order, undefined);
		this.blockRoots.release(message.root);
		this.residentTailBytes -= message.tailBytes;
		this.hotWitnessBytes -= message.witnessBytes;
		this.active.delete(messageId);
		this.identity.release(messageId);
	}

	private block(address: BlockAddress): ActiveBlock {
		const block = this.active.get(address.messageId)?.blocks.get(address.contentIndex);
		if (!block) throw new CompactTransitionError("unknown_block", `${address.messageId}#${address.contentIndex}`);
		return block;
	}
}
