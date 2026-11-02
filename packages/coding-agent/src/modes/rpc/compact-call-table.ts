import { type CallCounters, callLeaves, callOrder, type OutstandingCall, terminal } from "./compact-call-model.ts";
import { CompactComponentRoots, type ComponentRoot } from "./compact-component-roots.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

interface Slot {
	readonly ref: ValueRef;
	readonly bytes: number;
}
interface Entry {
	call: OutstandingCall;
	readonly order: string;
}
const turnKey = (turnId: string, toolCallId: string) => `${turnId}\u0000${toolCallId}`;
const messageKey = (messageId: string, contentIndex: number) => `${messageId}#${contentIndex}`;
const sharedKey = (messageId: string, toolCallId: string) => `${messageId}\u0000${toolCallId}`;

/**
 * The resident side of the calls component (S06 design section 2): the live entries, four indexes, the owned slot
 * values, and the persistent root every change republishes through the shared component roots.
 */
export class CompactCallTable {
	root: ComponentRoot<OutstandingCall> = { header: undefined, ref: undefined };
	private readonly store: CompactContentStore;
	private readonly values: CompactValues;
	private readonly roots: CompactComponentRoots<OutstandingCall>;
	private readonly entries = new Map<string, Entry>();
	private readonly byTurn = new Map<string, string>();
	private readonly byMessage = new Map<string, string>();
	private readonly byId = new Map<string, string[]>();
	private readonly children = new Map<string, Set<string>>();
	private readonly shared = new Set<string>();
	private slotBytes = 0;
	private headerBytes = 0;
	readonly counters = { replacements: 0, progressReplacements: 0, unknown: 0, late: 0, collisions: 0, reused: 0 };

	constructor(store: CompactContentStore) {
		this.store = store;
		this.values = new CompactValues(store);
		this.roots = new CompactComponentRoots(store, callLeaves);
	}

	get(key: string): OutstandingCall | undefined {
		return this.entries.get(key)?.call;
	}

	byTurnId(turnId: string | null, toolCallId: string | null): OutstandingCall | undefined {
		if (turnId === null || !toolCallId) return undefined;
		const key = this.byTurn.get(turnKey(turnId, toolCallId));
		return key === undefined ? undefined : this.get(key);
	}

	byOwner(messageId: string, contentIndex: number): OutstandingCall | undefined {
		const key = this.byMessage.get(messageKey(messageId, contentIndex));
		return key === undefined ? undefined : this.get(key);
	}

	/** The newest call with this id that is non-terminal or holds a synthetic outcome (design section 3). */
	newestById(toolCallId: string): OutstandingCall | undefined {
		const keys = this.byId.get(toolCallId) ?? [];
		for (let index = keys.length - 1; index >= 0; index--) {
			const call = this.get(keys[index]);
			if (call && (!terminal(call) || call.outcome?.kind === "abandoned")) return call;
		}
		return undefined;
	}

	/**
	 * The oldest `open` call with this id, its own turn first (FIFO by creation, senpi#4278): when a reused id overlaps
	 * a call still executing, each execution end closes, and each carrier settles, the call it belongs to.
	 */
	oldestById(
		toolCallId: string,
		turnId: string | null,
		open: (call: OutstandingCall) => boolean,
	): OutstandingCall | undefined {
		const rank = (entry: Entry) => `${entry.call.turnId === turnId ? 0 : 1}${entry.order}`;
		let oldest: Entry | undefined;
		for (const key of this.byId.get(toolCallId) ?? []) {
			const entry = this.entries.get(key);
			if (entry && open(entry.call) && (!oldest || rank(entry) < rank(oldest))) oldest = entry;
		}
		return oldest?.call;
	}

	/**
	 * RULING-123, C3.4: whether another call of `call`'s own message took the same toolCallId. An execution or hook
	 * record names only the toolCallId, so it cannot say which of those calls it is about. The mark lasts while any call
	 * of that message and id is live, so a later record is not attributed by elimination either.
	 */
	sharesIdInMessage(call: OutstandingCall): boolean {
		const { owningMessageId, toolCallId } = call;
		return owningMessageId !== null && toolCallId !== null && this.shared.has(sharedKey(owningMessageId, toolCallId));
	}

	*ofTurn(turnId: string): Iterable<OutstandingCall> {
		for (const { call } of this.entries.values()) if (call.turnId === turnId) yield call;
	}

	*all(): Iterable<OutstandingCall> {
		for (const { call } of this.entries.values()) yield call;
	}

	childrenOf(parentKey: string): readonly OutstandingCall[] {
		const keys = [...(this.children.get(parentKey) ?? [])];
		return keys.flatMap((key) => this.get(key) ?? []);
	}

	/** Measured before owning: a value the engine cannot serialize (too deep) throws with nothing owned yet (RULING-59). */
	own(value: unknown): Slot {
		const bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
		return { ref: this.values.own(value), bytes };
	}

	/** X07 `slotBytes` counts one copy per slot: the replaced value's bytes leave with it. */
	replaceSlot(call: OutstandingCall, field: "hook" | "progress" | "result", value: unknown): OutstandingCall {
		const slot = this.own(value);
		const previous = call[field];
		const next = { ...call, [field]: slot.ref };
		this.slotBytes += slot.bytes - (previous ? (this.slotBytesOf.get(previous) ?? 0) : 0);
		this.slotBytesOf.set(slot.ref, slot.bytes);
		if (previous) this.slotBytesOf.delete(previous);
		this.reput(next);
		this.store.adjust(slot.ref.owner, -1, 0);
		return next;
	}

	private readonly slotBytesOf = new WeakMap<ValueRef, number>();

	/**
	 * Publishes a created or changed call at its creation ordinal and refreshes every index it is reachable by. The
	 * stored header carries `callUnknown: true` exactly while `sharesIdInMessage` holds for it (#5348), so the snapshot
	 * row, the in-process view and the settled projection all state the mark this table keeps; the first call to share
	 * an id with another of its message republishes the others marked.
	 */
	put(input: OutstandingCall, creation: { readonly sequence: number; readonly k: number }): void {
		this.putAt(input, callOrder(creation.sequence, creation.k));
	}

	/** A changed call keeps the creation ordinal its key was put at (RULING-13 Q1), whatever minted that key. */
	reput(input: OutstandingCall): void {
		const entry = this.entries.get(input.runtimeItemKey);
		if (!entry) throw new Error(`unknown call ${input.runtimeItemKey}`);
		this.putAt(input, entry.order);
	}

	private putAt(input: OutstandingCall, order: string): void {
		const call = marked(input, this.willShare(input));
		// Measured before anything changes, so a header the engine cannot serialize leaves the table as it was.
		const bytes = headerBytes(call);
		const previous = this.entries.get(call.runtimeItemKey)?.call;
		if (previous) this.unindex(previous);
		this.root = this.roots.set(this.root, order, call);
		this.counters.replacements++;
		this.headerBytes += bytes - (previous ? headerBytes(previous) : 0);
		this.entries.set(call.runtimeItemKey, { call, order });
		this.index(call);
		if (call.callUnknown && call.owningMessageId !== null && call.toolCallId !== null)
			for (const peer of this.inMessage(call.owningMessageId, call.toolCallId).map((key) => this.get(key)))
				if (peer && !peer.callUnknown) this.reput(peer);
	}

	/** Whether `call`, once put, shares its toolCallId inside its message: the mark is set, or another live call has it. */
	private willShare(call: OutstandingCall): boolean {
		const { owningMessageId, toolCallId, runtimeItemKey } = call;
		if (owningMessageId === null || !toolCallId) return false;
		if (this.shared.has(sharedKey(owningMessageId, toolCallId))) return true;
		return this.inMessage(owningMessageId, toolCallId).some((key) => key !== runtimeItemKey);
	}

	remove(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.unindex(entry.call);
		for (const slot of [entry.call.hook, entry.call.progress, entry.call.result])
			if (slot) {
				this.slotBytes -= this.slotBytesOf.get(slot) ?? 0;
				this.slotBytesOf.delete(slot);
			}
		this.headerBytes -= headerBytes(entry.call);
		this.entries.delete(key);
		const { owningMessageId, toolCallId } = entry.call;
		if (owningMessageId !== null && toolCallId && !this.inMessage(owningMessageId, toolCallId).length)
			this.shared.delete(sharedKey(owningMessageId, toolCallId));
		this.root = this.roots.set(this.root, entry.order, undefined);
		this.counters.replacements++;
	}

	/** Whether another live call already owns this (turn, id) slot: a collision leaves the index unchanged. */
	indexedTo(turnId: string, toolCallId: string): string | undefined {
		return this.byTurn.get(turnKey(turnId, toolCallId));
	}

	/** A reused id (senpi#4278) points the (turn, id) slot at the fresh call. */
	repoint(turnId: string, toolCallId: string, key: string): void {
		this.byTurn.set(turnKey(turnId, toolCallId), key);
	}

	snapshot(): CallCounters {
		let carrierless = 0;
		for (const { call } of this.entries.values()) if (call.join === "carrierless") carrierless++;
		return {
			live: this.entries.size,
			carrierless,
			replacements: this.counters.replacements,
			headerBytes: this.headerBytes,
			slotBytes: this.slotBytes,
			progressReplacements: this.counters.progressReplacements,
			ignored: { unknown: this.counters.unknown, late: this.counters.late },
			collisions: this.counters.collisions,
			reused: this.counters.reused,
		};
	}

	freeze(): ValueRef | undefined {
		if (this.root.ref) this.store.adjust(this.root.ref.owner, 0, 1);
		return this.root.ref;
	}

	release(ref: ValueRef | undefined): void {
		if (ref) this.store.adjust(ref.owner, 0, -1);
	}

	entriesOf(ref: ValueRef | undefined, valid: () => void) {
		return this.roots.entries(ref, valid);
	}

	private index(call: OutstandingCall): void {
		if (call.toolCallId) {
			const slot = turnKey(call.turnId, call.toolCallId);
			if (!this.byTurn.has(slot) || this.byTurn.get(slot) === call.runtimeItemKey)
				this.byTurn.set(slot, call.runtimeItemKey);
			const keys = this.byId.get(call.toolCallId) ?? [];
			if (!keys.includes(call.runtimeItemKey)) this.byId.set(call.toolCallId, [...keys, call.runtimeItemKey]);
			if (call.owningMessageId !== null && call.callUnknown)
				this.shared.add(sharedKey(call.owningMessageId, call.toolCallId));
		}
		if (call.owningMessageId !== null && call.contentIndex !== null)
			this.byMessage.set(messageKey(call.owningMessageId, call.contentIndex), call.runtimeItemKey);
		if (call.parentKey !== null) {
			const siblings = this.children.get(call.parentKey) ?? new Set();
			siblings.add(call.runtimeItemKey);
			this.children.set(call.parentKey, siblings);
		}
	}

	/** The live calls of one message under one toolCallId. */
	private inMessage(messageId: string, toolCallId: string): readonly string[] {
		return (this.byId.get(toolCallId) ?? []).filter((key) => this.get(key)?.owningMessageId === messageId);
	}

	private unindex(call: OutstandingCall): void {
		if (call.toolCallId) {
			const slot = turnKey(call.turnId, call.toolCallId);
			if (this.byTurn.get(slot) === call.runtimeItemKey) this.byTurn.delete(slot);
			const keys = (this.byId.get(call.toolCallId) ?? []).filter((key) => key !== call.runtimeItemKey);
			if (keys.length) this.byId.set(call.toolCallId, keys);
			else this.byId.delete(call.toolCallId);
		}
		if (call.owningMessageId !== null && call.contentIndex !== null) {
			const slot = messageKey(call.owningMessageId, call.contentIndex);
			if (this.byMessage.get(slot) === call.runtimeItemKey) this.byMessage.delete(slot);
		}
		if (call.parentKey !== null) {
			const siblings = this.children.get(call.parentKey);
			siblings?.delete(call.runtimeItemKey);
			if (siblings?.size === 0) this.children.delete(call.parentKey);
		}
	}
}

function marked(call: OutstandingCall, ambiguous: boolean): OutstandingCall {
	const { callUnknown: _mark, ...header } = call;
	return ambiguous ? { ...header, callUnknown: true } : header;
}

function headerBytes(call: OutstandingCall): number {
	return Buffer.byteLength(JSON.stringify(call));
}
