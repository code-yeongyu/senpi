/**
 * The tool child's barrier clock (senpi#3566, plan todo 4).
 *
 * One `Int32Array` over a `SharedArrayBuffer`, shared by the child's protocol loop and every kernel worker. Index 0 is
 * a monotonic clock; after it, one slot per in-flight launch holds `{ackTick, invokeTick, invocations, inUse}`. The
 * protocol loop stores `ackTick` when `launch_ack` arrives; every launch path stores `invokeTick` and bumps
 * `invocations` immediately before it calls the real spawn API. `ackTick < invokeTick` read from the same clock is the
 * causal proof that no command ran before the server recorded its containment handle, independent of transport order
 * or of how long the command runs. Tick 0 never occurs, so 0 in a slot means "not yet".
 */

const CLOCK = 0;
const SLOT_FIELDS = 4;
const ACK = 0;
const INVOKE = 1;
const INVOCATIONS = 2;
const IN_USE = 3;

export const DEFAULT_LAUNCH_SLOTS = 256;

export interface SlotState {
	readonly ackTick: number | null;
	readonly invokeTick: number | null;
	readonly invocations: number;
}

export type AckWait = "acked" | "timed-out";

export class BarrierClock {
	readonly buffer: SharedArrayBuffer;
	readonly slots: number;
	private readonly cells: Int32Array;

	constructor(buffer: SharedArrayBuffer) {
		if (buffer.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) throw new Error("barrier clock buffer is misaligned");
		const length = buffer.byteLength / Int32Array.BYTES_PER_ELEMENT;
		if (length < 1 + SLOT_FIELDS || (length - 1) % SLOT_FIELDS !== 0)
			throw new Error("barrier clock buffer has no slots");
		this.buffer = buffer;
		this.cells = new Int32Array(buffer);
		this.slots = (length - 1) / SLOT_FIELDS;
	}

	static create(slots: number = DEFAULT_LAUNCH_SLOTS): BarrierClock {
		if (!Number.isInteger(slots) || slots < 1) throw new Error(`barrier clock needs at least one slot, got ${slots}`);
		return new BarrierClock(new SharedArrayBuffer((1 + slots * SLOT_FIELDS) * Int32Array.BYTES_PER_ELEMENT));
	}

	/** The next tick; strictly increasing across every thread sharing the buffer. */
	tick(): number {
		return Atomics.add(this.cells, CLOCK, 1) + 1;
	}

	/** Claims a free slot for one launch (protocol loop only), or undefined when all are in flight. */
	claimSlot(): number | undefined {
		for (let slot = 0; slot < this.slots; slot++) {
			if (Atomics.compareExchange(this.cells, this.index(slot, IN_USE), 0, 1) !== 0) continue;
			Atomics.store(this.cells, this.index(slot, ACK), 0);
			Atomics.store(this.cells, this.index(slot, INVOKE), 0);
			Atomics.store(this.cells, this.index(slot, INVOCATIONS), 0);
			return slot;
		}
		return undefined;
	}

	releaseSlot(slot: number): void {
		Atomics.store(this.cells, this.index(slot, IN_USE), 0);
	}

	/** Protocol loop, on `launch_ack`: records the tick and wakes a worker blocked in `waitForAck`. */
	recordAck(slot: number): number {
		const tick = this.tick();
		Atomics.store(this.cells, this.index(slot, ACK), tick);
		Atomics.notify(this.cells, this.index(slot, ACK));
		return tick;
	}

	/**
	 * Launch path, immediately before the real call: stores the invoke tick and counts the invocation. Returns the
	 * ticks the proof carries; `ackTick` is null when the call proceeds without an ack (only a mutation can do that).
	 */
	recordInvoke(slot: number): { readonly ackTick: number | null; readonly invokeTick: number } {
		const ackTick = Atomics.load(this.cells, this.index(slot, ACK));
		const invokeTick = this.tick();
		Atomics.store(this.cells, this.index(slot, INVOKE), invokeTick);
		Atomics.add(this.cells, this.index(slot, INVOCATIONS), 1);
		return { ackTick: ackTick === 0 ? null : ackTick, invokeTick };
	}

	/** Worker thread only: blocks until the protocol loop records the slot's ack. */
	waitForAck(slot: number, timeoutMs: number = Number.POSITIVE_INFINITY): AckWait {
		const at = this.index(slot, ACK);
		while (Atomics.load(this.cells, at) === 0) {
			if (Atomics.wait(this.cells, at, 0, timeoutMs) === "timed-out") return "timed-out";
		}
		return "acked";
	}

	read(slot: number): SlotState {
		const ackTick = Atomics.load(this.cells, this.index(slot, ACK));
		const invokeTick = Atomics.load(this.cells, this.index(slot, INVOKE));
		return {
			ackTick: ackTick === 0 ? null : ackTick,
			invokeTick: invokeTick === 0 ? null : invokeTick,
			invocations: Atomics.load(this.cells, this.index(slot, INVOCATIONS)),
		};
	}

	private index(slot: number, field: number): number {
		if (!Number.isInteger(slot) || slot < 0 || slot >= this.slots) throw new Error(`no barrier slot ${slot}`);
		return 1 + slot * SLOT_FIELDS + field;
	}
}

/** The proof the server enforces: an ack exists and it precedes the invocation on the shared clock. */
export function proofIsOrdered(proof: { readonly ackTick: number | null; readonly invokeTick: number }): boolean {
	return proof.ackTick !== null && proof.ackTick < proof.invokeTick;
}
