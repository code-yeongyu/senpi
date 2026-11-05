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
	/** The scope's floor in force, or `undefined` while no owner raised one (senpi#5916). */
	floorOf(scope: string): number | undefined;
}

export interface HandEpochFenceOptions {
	/**
	 * The brain principal that owns each scope's session now: the embedder's placement record, which changes when the
	 * session moves. Only that owner raises the scope's floor; any other sender is refused, whatever grant it holds.
	 */
	readonly ownerOf: (scope: string) => string | undefined;
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
	const { durable, ownerOf } = options;
	const floors = new Map<string, Floor>();
	const ready = (async () => {
		if (durable === undefined) return;
		for (const document of await durable.store.scanDocuments(EPOCH_FLOOR_PREFIX))
			floors.set(document.key.slice(EPOCH_FLOOR_PREFIX.length), decodeFloor(document.data));
	})();

	const raiseNow = async (scope: string, epoch: number, sender: string): Promise<FloorRaise> => {
		if (ownerOf(scope) !== sender) return { kind: "refused", reason: "peer_unauthorized" };
		const current = floors.get(scope);
		const floor = current?.epoch ?? 0;
		if (epoch < floor) return { kind: "acked", floor };
		if (current !== undefined && epoch === floor)
			return current.owner === sender ? { kind: "acked", floor } : { kind: "refused", reason: "epoch_fenced" };
		if (epoch - floor > EPOCH_FLOOR_MAX_STEP) return { kind: "refused", reason: "epoch_step_exceeded" };
		const next: Floor = { epoch, owner: sender };
		if (durable === undefined) floors.set(scope, next);
		else {
			const write = { op: "put" as const, key: `${EPOCH_FLOOR_PREFIX}${scope}`, data: { ...next } };
			await durable.store.commit(durable.epoch, [write], () => floors.set(scope, next));
		}
		return { kind: "acked", floor: epoch };
	};

	return {
		ready,
		async raise(scope, epoch, sender) {
			await ready;
			const run = () => raiseNow(scope, epoch, sender);
			return durable === undefined ? run() : durable.admission.admit(run);
		},
		floorOf: (scope) => floors.get(scope)?.epoch,
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
