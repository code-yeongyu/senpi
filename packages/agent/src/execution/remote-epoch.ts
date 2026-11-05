import type { AdmissionLine } from "../durable/store-admission.ts";
import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { EpochRefusal, RemoteHandMessage } from "./remote-protocol.ts";

/** A raise moves a scope's floor by at most one epoch, counted from 0 (relay design 4.4, SP6 `EPOCH_FLOOR_MAX_STEP`). */
export const EPOCH_FLOOR_MAX_STEP = 1;
/** The hand-store documents holding each scope's floor: this prefix, then the scope ID. */
export const EPOCH_FLOOR_PREFIX = "hand.epoch-floor:";
/** The sender a self link (fused, split-local) presents to the fence; a peer link presents its authenticated peer. */
export const HAND_SELF_SENDER = "self";

export type FloorRaise =
	| { readonly kind: "acked"; readonly floor: number }
	| { readonly kind: "refused"; readonly reason: Exclude<EpochRefusal, "epoch_unsupported"> };

export interface HandEpochFence {
	/** Settles once the floors persisted by an earlier process are in force; nothing is admitted before. */
	readonly ready: Promise<void>;
	/** Raises `scope`'s floor to `epoch` for `sender`, or says why not; a raise below the floor answers the floor. */
	raise(scope: string, epoch: number, sender: string): Promise<FloorRaise>;
	/**
	 * Whether a message from `sender` at `epoch` (none: from before epochs) may act on `scope`: anything above the floor,
	 * or the floor's own owner at the floor's epoch. Synchronous, so it can run inside a ledger step's admission slot.
	 */
	admits(scope: string, epoch: number | undefined, sender: string): boolean;
}

/**
 * The owner of a scope's session: the brain principal, and, when the placement is claimed by CAS, the epoch its claim
 * recorded (SP6 `PlacementOwner`). A claim winner that died before raising its floor leaves the next owner more than one
 * epoch above the floor; that owner may raise to exactly its recorded epoch, and never above it (senpi#5860).
 */
export type ScopeOwner = string | { readonly principal: string; readonly epoch: number };

export interface HandEpochFenceOptions {
	/**
	 * The hand's copy of the record of the brain principal that owns each scope's session now: the embedder's placement
	 * record, which changes when the session moves. Only that owner raises the scope's floor; any other sender is refused,
	 * whatever grant it holds.
	 */
	readonly ownerOf: (scope: string) => ScopeOwner | undefined;
	/**
	 * Reads the record itself (record freshness, senpi#5860): called before a raise whose epoch is above the owner the
	 * hand believes (the copy, or a newer read), never for a raise at or below it, and coalesced per scope; a raise that
	 * joined a read already in flight reads once more when that read still leaves it ahead. It runs before the raise joins
	 * the ledger's admission line, so a slow read never holds a ledger step. A copy that names a bare principal is never
	 * refreshed; a missing copy, or a removal the newest read found, is. Without it, the copy decides.
	 */
	readonly refreshOwner?: (scope: string) => Promise<ScopeOwner | undefined>;
	/**
	 * Where floors persist: the hand's store, under its owner epoch, on the execution ledger's admission line, so a floor
	 * and every ledger step are ordered and a restarted hand keeps the floors it acked. Without it, floors live as long
	 * as the process.
	 */
	readonly durable?: {
		readonly store: DurableStore;
		readonly epoch: number;
		readonly admission: AdmissionLine;
	};
}

interface Floor {
	readonly epoch: number;
	readonly owner: string;
}

function decodeFloor(data: StoreValue): Floor {
	if (typeof data === "object" && data !== null && !Array.isArray(data) && "epoch" in data && "owner" in data) {
		const { epoch, owner } = data;
		if (typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 1 && typeof owner === "string")
			return { epoch, owner };
	}
	throw new Error("A stored epoch floor is malformed");
}

/**
 * A hand's epoch floors, one per execution scope (brain/hand S35): the hand side of SP6's `EpochFence`. The floor
 * never lowers and remembers its owner, so after a move the old owner's delayed invoke, abort or ack is refused and a
 * rival at the new owner's epoch is fenced.
 */
export function createHandEpochFence(options: HandEpochFenceOptions): HandEpochFence {
	const { durable, ownerOf, refreshOwner } = options;
	const floors = new Map<string, Floor>();
	const ready = (async () => {
		if (durable === undefined) return;
		for (const document of await durable.store.scanDocuments(EPOCH_FLOOR_PREFIX))
			floors.set(document.key.slice(EPOCH_FLOOR_PREFIX.length), decodeFloor(document.data));
	})();

	/** One record read: what it answered (`undefined`: the record is removed) and its place in this fence's read order. */
	interface RecordRead {
		readonly owner: ScopeOwner | undefined;
		readonly seq: number;
	}
	let reads = 0;
	const reading = new Map<string, Promise<RecordRead>>();
	/** The newest read per scope, a removal included: until a newer read, it outranks any copy no newer than it. */
	const lastRead = new Map<string, RecordRead>();
	const refreshed = (scope: string, read: NonNullable<typeof refreshOwner>): Promise<RecordRead> => {
		const inFlight = reading.get(scope);
		if (inFlight !== undefined) return inFlight;
		const seq = ++reads;
		const next = read(scope)
			.then((owner) => {
				const result: RecordRead = { owner, seq };
				if ((lastRead.get(scope)?.seq ?? 0) < seq) lastRead.set(scope, result);
				return result;
			})
			.finally(() => reading.delete(scope));
		reading.set(scope, next);
		return next;
	};
	/** The owner the hand believes now: the copy, unless the newest read is newer than it or found the record removed. */
	const copyOf = (scope: string): ScopeOwner | undefined => {
		const copy = ownerOf(scope);
		const read = lastRead.get(scope)?.owner;
		// Fail closed: a missing copy, or a read that found the record removed, names no owner. A raise arriving then reads
		// the record before it joins the line (I1) and decides on the newest read at its turn (I2); a raise already on the
		// line with no read of its own is refused `peer_unauthorized`, since no read runs inside the line.
		if (copy === undefined || (lastRead.has(scope) && read === undefined)) return undefined;
		if (typeof read !== "object" || typeof copy === "string") return copy;
		return copy.epoch >= read.epoch ? copy : read;
	};
	/** The record read a raise needs (`undefined`: none; the copy decides at the raise's turn on the admission line). */
	const readFor = async (scope: string, epoch: number): Promise<RecordRead | undefined> => {
		const ahead = (owner: ScopeOwner | undefined): boolean =>
			typeof owner !== "string" && epoch > (owner?.epoch ?? 0);
		if (!ahead(copyOf(scope)) || refreshOwner === undefined) return undefined;
		// A read already in flight may have started before this raiser's claim landed; if it still leaves the raise ahead,
		// read once more (that read starts after this raise arrived, so after its claim).
		const joined = reading.has(scope);
		const first = await refreshed(scope, refreshOwner);
		return joined && ahead(first.owner) ? refreshed(scope, refreshOwner) : first;
	};
	/** The owner a raise is decided on, at its turn: the newest read by then (its own or a later one), unless the copy
	 * names a higher epoch; with no read of its own, the copy as the hand believes it then. */
	const ownerAtTurn = (scope: string, read: RecordRead | undefined): ScopeOwner | undefined => {
		if (read === undefined) return copyOf(scope);
		const newest = lastRead.get(scope);
		const decided = newest !== undefined && newest.seq > read.seq ? newest.owner : read.owner;
		if (decided === undefined) return undefined;
		const copy = ownerOf(scope);
		return typeof copy === "object" && typeof decided === "object" && copy.epoch > decided.epoch ? copy : decided;
	};

	const raiseNow = async (
		scope: string,
		epoch: number,
		sender: string,
		owner: ScopeOwner | undefined,
	): Promise<FloorRaise> => {
		const principal = typeof owner === "string" ? owner : owner?.principal;
		if (principal !== sender) return { kind: "refused", reason: "peer_unauthorized" };
		const recorded = typeof owner === "string" ? undefined : owner?.epoch;
		const current = floors.get(scope);
		const floor = current?.epoch ?? 0;
		if (epoch < floor) return { kind: "acked", floor };
		if (current !== undefined && epoch === floor)
			return current.owner === sender ? { kind: "acked", floor } : { kind: "refused", reason: "epoch_fenced" };
		// The record's owner below its recorded epoch (an instance that claimed twice): the floor in force, nothing moves.
		if (current !== undefined && recorded !== undefined && epoch < recorded) return { kind: "acked", floor };
		const reachable = recorded ?? floor + EPOCH_FLOOR_MAX_STEP;
		if (epoch > reachable) return { kind: "refused", reason: "epoch_step_exceeded" };
		// With no floor yet, an earlier instance of the record's owner opens it at the recorded epoch, never its own lower one:
		// its gate reads the higher ack as superseded, and the instance at the recorded epoch is acked when it raises.
		const next: Floor = { epoch: recorded ?? epoch, owner: sender };
		if (durable === undefined) floors.set(scope, next);
		else {
			const write = { op: "put" as const, key: `${EPOCH_FLOOR_PREFIX}${scope}`, data: { ...next } };
			await durable.store.commit(durable.epoch, [write], () => floors.set(scope, next));
		}
		return { kind: "acked", floor: next.epoch };
	};

	return {
		ready,
		async raise(scope, epoch, sender) {
			await ready;
			const read = await readFor(scope, epoch);
			const run = (): Promise<FloorRaise> => raiseNow(scope, epoch, sender, ownerAtTurn(scope, read));
			return durable === undefined ? run() : durable.admission.admit(run);
		},
		admits(scope, epoch, sender) {
			const floor = floors.get(scope);
			if (floor === undefined) return true;
			const at = epoch ?? 0;
			return at > floor.epoch || (at === floor.epoch && floor.owner === sender);
		},
	};
}

/** The hand's answer to a floor on `scope`: a hand with no fence refuses it, so its session never dispatches unfenced. */
export async function answerFloor(
	fence: HandEpochFence | undefined,
	scope: string,
	epoch: number,
	sender: string,
): Promise<RemoteHandMessage> {
	if (fence === undefined) return { kind: "floor_refused", reason: "epoch_unsupported" };
	const raised = await fence.raise(scope, epoch, sender);
	return raised.kind === "acked"
		? { kind: "floor_ack", floor: raised.floor }
		: { kind: "floor_refused", reason: raised.reason };
}
