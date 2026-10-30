import { type ActiveBlock, adjustBlock, appendBlock, deltaBlock } from "./compact-active-block.ts";
import { CompactActiveMessages } from "./compact-active-messages.ts";
import { type CallFold, foldCallBlock, foldCallRecord, foldCallTerminal } from "./compact-call-fold.ts";
import type { CallScope } from "./compact-call-model.ts";
import { readCalls } from "./compact-call-view.ts";
import { type CompactColdFlow, coldFlowOperations } from "./compact-cold-flows.ts";
import type { CompactColdOperation } from "./compact-cold-operations.ts";
import { CompactCurrentComponents } from "./compact-current-components.ts";
import { CompactReadError, CompactReadLease } from "./compact-read-lease.ts";
import { foldSeededBlock } from "./compact-seeded-block.ts";
import { CompactSeededDraft } from "./compact-seeded-draft.ts";
import { recordMessage, seedMessage, updateFields } from "./compact-seeded-messages.ts";
import { CompactSessionCalls } from "./compact-session-calls.ts";
import { type FrozenCompactState, readActiveMessages, readCompactState } from "./compact-state-view.ts";
import { type CompactTransition, CompactTransitionError } from "./compact-transition.ts";
export type { CompactSessionStateOptions } from "./compact-state-storage.ts";

/** Synchronous acceptance; cuts and settlement transfer persistent component roots (senpi#4272). */
export class CompactSessionState extends CompactActiveMessages {
	private frozenTailBytes = 0;
	private readonly cuts = new WeakMap<FrozenCompactState, CompactReadLease>();
	private readonly components = new CompactCurrentComponents(this.store);
	private readonly calls = new CompactSessionCalls(this.store);

	get acceptedSequence(): number {
		return this.sequence;
	}

	/** Open broadcast questions right now, for synchronous status reads (R3.C6.4). */
	get openBroadcastDialogs(): number {
		return this.components.openBroadcast;
	}

	/**
	 * `sequence` is the acceptance lane's own sequence for this unit (one numbering with the lane, RULING-26);
	 * `turnId` is the lane-minted turn the unit belongs to, consumed by the calls component (RULING-13 Q6).
	 */
	accept(t: CompactTransition, sequence = this.sequence + 1, turnId: string | null = null): number {
		if (t.type !== "message_remove") this.store.assertReadable();
		const step = { sequence, scope: this.callScope(turnId) };
		if ((t.type === "message_status" || t.type === "message_remove") && !this.active.has(t.messageId))
			throw new CompactTransitionError("cold_operation_required", "use applyCold after acceptance");
		switch (t.type) {
			case "seeded_block": {
				const address = { messageId: t.messageId, contentIndex: t.event.contentIndex };
				const old = this.active.get(t.messageId)?.blocks.get(address.contentIndex);
				if (old?.epoch !== undefined && old.epoch !== t.epoch)
					throw new CompactTransitionError("wrong_epoch", t.messageId);
				if (!Number.isSafeInteger(address.contentIndex) || address.contentIndex < 0)
					throw new CompactTransitionError("unknown_block", String(address.contentIndex));
				const starting =
					"seed" in t.event ||
					(t.event.type === "message_block_state" &&
						t.event.phase === "insert" &&
						(!old || old.seeded?.phase === "initial"));
				if (starting) this.identity.validate(t);
				using draft = new CompactSeededDraft(this.store);
				const fields = updateFields(draft, this.active.get(t.messageId)?.fields, t);
				const block = foldSeededBlock(draft, old?.seeded, t.event);
				this.publish(address, { ...block.body, seeded: block, epoch: t.epoch }, fields);
				if (starting) this.identity.commit(t);
				foldCallBlock(this.calls, t, step, this.active.get(t.messageId)?.blocks.get(address.contentIndex));
				break;
			}
			case "seeded_message": {
				const { message, terminal } = recordMessage(t.record);
				// The terminal replaces the live blocks, so the calls own their raw text from the blocks being replaced.
				if (terminal)
					foldCallTerminal(this.calls, t.messageId, message, step, this.active.get(t.messageId)?.blocks);
				this.acceptMessage(t);
				break;
			}
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
				this.settle(t.messageId, t.persistence);
				break;
			case "message_remove":
				this.dropActive(t.messageId);
				break;
			case "component":
				this.components.apply(t.record);
				break;
		}
		this.sequence = sequence;
		return sequence;
	}

	/** A call record at its lane step; `changed` is false when the record is ignored and takes no sequence (Q9). */
	acceptCall(record: object, sequence: number, turnId: string | null): CallFold {
		this.store.assertReadable();
		const fold = foldCallRecord(this.calls, record, this.callScope(turnId), sequence);
		if (fold.changed) this.sequence = sequence;
		return fold;
	}

	applyCold(t: CompactColdOperation) {
		return this.cold.run(t, this.sequence);
	}

	/** One ordered cold unit per flow: its operations run back to back after acceptance, each with its outcome. */
	applyColdFlow(flow: CompactColdFlow) {
		return this.cold.runAll(coldFlowOperations(flow), this.sequence);
	}

	freeze(): FrozenCompactState {
		this.store.assertReadable();
		const active = this.messages.ref;
		const tails = this.residentTailBytes;
		if (active) this.store.adjust(active.owner, 0, 1);
		this.frozenTailBytes += tails;
		const frozen = {
			sequence: this.sequence,
			active,
			settled: this.settled.freeze(),
			components: this.components.freeze(),
			calls: this.calls.freeze(),
		};
		this.cuts.set(
			frozen,
			new CompactReadLease(() => {
				if (active) this.store.adjust(active.owner, 0, -1);
				this.frozenTailBytes -= tails;
				this.settled.release(frozen.settled);
				this.components.release(frozen.components);
				this.calls.release(frozen.calls);
			}),
		);
		return frozen;
	}

	release(frozen: FrozenCompactState): void {
		this.cutLease(frozen).release();
	}

	/** Whole-view compatibility assembly; persistent nodes and text ranges are read separately. */
	async read(frozen: FrozenCompactState) {
		return this.under(frozen, (valid) => readCompactState(frozen, { ...this.roots, settled: this.settled }, valid));
	}

	/** The live messages at the cut with the current value of every block (R3.C6.4), never the settled history. */
	readActive(frozen: FrozenCompactState) {
		return this.under(frozen, (valid) => readActiveMessages(frozen, this.roots, valid));
	}

	/** Run state, lifecycle and open dialogs at the cut (RULING-26 Q4). */
	readComponents(frozen: FrozenCompactState) {
		return this.under(frozen, (valid) => this.components.read(frozen.components, valid));
	}

	/** The outstanding calls at the cut (R3.C3), raw text resolved from the slots the calls own. */
	readCalls(frozen: FrozenCompactState) {
		const owner = { calls: this.calls, ...this.roots };
		return this.under(frozen, (valid) => readCalls(frozen, owner, valid));
	}

	private get roots() {
		return { store: this.store, blockRoots: this.blockRoots, messageRoots: this.messageRoots };
	}

	private callScope(turnId: string | null): CallScope {
		return { sessionEpoch: this.sessionEpoch, turnId };
	}

	private cutLease(frozen: FrozenCompactState): CompactReadLease {
		const lease = this.cuts.get(frozen);
		if (!lease) throw new CompactReadError("ownership");
		return lease;
	}

	/** Every read runs under the cut's operation lease and re-checks it with the store at each step. */
	private under<T>(frozen: FrozenCompactState, read: (valid: () => void) => Promise<T>): Promise<T> {
		const lease = this.cutLease(frozen);
		const valid = () => {
			lease.assert();
			this.store.assertReadable();
		};
		valid();
		return lease.run(() => read(valid));
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
	}

	/** A start installs initial slots once; a terminal wins whole, and the outer end settles it as pending. */
	private acceptMessage(t: Extract<CompactTransition, { type: "seeded_message" }>): void {
		const live = this.active.get(t.messageId);
		if (live?.epoch !== undefined && live.epoch !== t.epoch)
			throw new CompactTransitionError("wrong_epoch", t.messageId);
		const { message, terminal } = recordMessage(t.record);
		if (!terminal && [...(live?.blocks.values() ?? [])].some((block) => block.seeded?.phase !== "initial"))
			throw new CompactTransitionError("invalid_phase", "a start cannot rewind streamed blocks");
		if (!live) this.identity.validate(t);
		using draft = new CompactSeededDraft(this.store);
		const next = seedMessage(draft, message, terminal, live?.blocks, t);
		// Bound once, by the first message-level record that carries it, even when an indexed start created the message.
		const correlation = live?.correlation ?? (t.correlation && draft.fields(t.correlation));
		this.install(t.messageId, { fields: next.fields, correlation, epoch: t.epoch }, next.blocks);
		if (!live) this.identity.commit(t);
		if (t.record.type === "message_end") this.settle(t.messageId, "pending");
	}
}
