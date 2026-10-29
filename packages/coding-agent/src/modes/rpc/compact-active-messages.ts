import type { ActiveBlock, ActiveMessage } from "./compact-active-block.ts";
import type { ComponentRoot } from "./compact-component-roots.ts";
import { frozenBlock, type SeededBlock } from "./compact-seeded-block.ts";
import type { SeededFields } from "./compact-seeded-draft.ts";
import { CompactStartIdentity } from "./compact-start-identity.ts";
import { CompactStateStorage } from "./compact-state-storage.ts";
import type { MessageRoot } from "./compact-state-view.ts";
import { type BlockAddress, type CompactPersistence, CompactTransitionError } from "./compact-transition.ts";

function rowOf(messageId: string, message: ActiveMessage): MessageRoot {
	return {
		messageId,
		...(message.root.ref ? { blocks: message.root.ref } : {}),
		...(message.fields ? { fields: message.fields } : {}),
		...(message.correlation ? { correlation: message.correlation } : {}),
	};
}

/** Live messages and their persistent block roots; every publication runs inside one synchronous acceptance. */
export class CompactActiveMessages extends CompactStateStorage {
	protected messages: ComponentRoot<MessageRoot> = { header: undefined, ref: undefined };
	protected readonly active = new Map<string, ActiveMessage>();
	protected readonly identity = new CompactStartIdentity();
	protected sequence = 0;
	protected residentTailBytes = 0;
	protected hotWitnessBytes = 0;

	protected override isActiveKey(key: string): boolean {
		return this.active.has(key);
	}

	protected publish(address: BlockAddress, block: ActiveBlock, fields?: SeededFields): void {
		const message = this.active.get(address.messageId) ?? { ...this.fresh(), epoch: block.epoch };
		if (fields) message.fields = fields;
		this.put(message, address.contentIndex, block);
		this.publishRow(address.messageId, message);
	}

	/** An authoritative whole message: a fresh block root, so no index the message no longer names survives. */
	protected install(
		messageId: string,
		parts: Pick<ActiveMessage, "fields" | "correlation"> & { readonly epoch: string },
		blocks: ReadonlyMap<number, SeededBlock>,
	): void {
		const old = this.active.get(messageId);
		const message: ActiveMessage = { ...this.fresh(old?.order), ...parts };
		for (const [index, block] of blocks)
			this.put(message, index, { ...block.body, seeded: block, epoch: parts.epoch });
		this.publishRow(messageId, message);
		if (old) this.discard(old);
	}

	protected settle(messageId: string, persistence: CompactPersistence): void {
		const message = this.active.get(messageId);
		this.settled.set(messageId, { ...(message ? rowOf(messageId, message) : { messageId }), persistence });
		this.dropActive(messageId);
	}

	protected dropActive(messageId: string): void {
		const message = this.active.get(messageId);
		if (!message) return;
		this.messages = this.messageRoots.set(this.messages, message.order, undefined);
		this.discard(message);
		this.active.delete(messageId);
		this.identity.release(messageId);
	}

	protected block(address: BlockAddress): ActiveBlock {
		const block = this.active.get(address.messageId)?.blocks.get(address.contentIndex);
		if (!block) throw new CompactTransitionError("unknown_block", `${address.messageId}#${address.contentIndex}`);
		return block;
	}

	private fresh(order = String(this.sequence).padStart(16, "0")): ActiveMessage {
		return { order, blocks: new Map(), root: { header: undefined, ref: undefined }, tailBytes: 0, witnessBytes: 0 };
	}

	private put(message: ActiveMessage, contentIndex: number, block: ActiveBlock): void {
		const old = message.blocks.get(contentIndex);
		const tails =
			(block.tail.length +
				(block.seeded?.signature.tail.length ?? 0) -
				(old?.tail.length ?? 0) -
				(old?.seeded?.signature.tail.length ?? 0)) *
			2;
		const witness = (block.witness.length - (old?.witness.length ?? 0)) * 2;
		message.root = this.blockRoots.set(
			message.root,
			String(contentIndex).padStart(16, "0"),
			frozenBlock(contentIndex, block),
		);
		message.blocks.set(contentIndex, block);
		message.tailBytes += tails;
		message.witnessBytes += witness;
		this.residentTailBytes += tails;
		this.hotWitnessBytes += witness;
	}

	private publishRow(messageId: string, message: ActiveMessage): void {
		this.messages = this.messageRoots.set(this.messages, message.order, rowOf(messageId, message));
		// The only entry into `active`, so every start path voids cold work queued while the key was settled.
		if (!this.active.has(messageId)) this.cold.activate(messageId);
		this.active.set(messageId, message);
	}

	private discard(message: ActiveMessage): void {
		this.blockRoots.release(message.root);
		this.residentTailBytes -= message.tailBytes;
		this.hotWitnessBytes -= message.witnessBytes;
	}
}
