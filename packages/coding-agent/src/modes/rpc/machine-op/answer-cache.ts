/**
 * `machine_op` answers by op_id (senpi#6752): an op runs once; a repeat gets the first answer, and a repeat that arrives
 * while the first still runs joins it. `machine_op_result` reads only settled answers, so after its own restart the
 * relay host can learn how an op ended (and re-sending the same op_id joins one still running). Bounded by count and by
 * age since settling; an op_id past either bound is unknown again. Each answer is bound to the owner (the sender) that
 * ran it: `ownerOf` lets the caller refuse another owner's repeat instead of handing it that answer.
 */
export const MACHINE_OP_CACHE_MAX_ENTRIES = 4_096;
export const MACHINE_OP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Slot<T> = Readonly<{ owner: string }> &
	(Readonly<{ running: Promise<T> }> | Readonly<{ value: T; settledAt: number }>);

export class MachineOpAnswerCache<T> {
	private readonly slots = new Map<string, Slot<T>>();
	private readonly now: () => number;

	constructor(options: { readonly now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	get size(): number {
		this.expire();
		return this.slots.size;
	}

	settled(opId: string): T | undefined {
		this.expire();
		const slot = this.slots.get(opId);
		return slot !== undefined && "value" in slot ? slot.value : undefined;
	}

	ownerOf(opId: string): string | undefined {
		this.expire();
		return this.slots.get(opId)?.owner;
	}

	answer(opId: string, owner: string, run: () => Promise<T>): Promise<T> {
		this.expire();
		const slot = this.slots.get(opId);
		if (slot !== undefined) return "running" in slot ? slot.running : Promise.resolve(slot.value);
		const running = run().then(
			(value) => {
				this.slots.delete(opId);
				this.slots.set(opId, { owner, value, settledAt: this.now() });
				this.trim();
				return value;
			},
			(error: unknown) => {
				this.slots.delete(opId);
				throw error;
			},
		);
		this.slots.set(opId, { owner, running });
		return running;
	}

	private expire(): void {
		const oldest = this.now() - MACHINE_OP_CACHE_MAX_AGE_MS;
		for (const [opId, slot] of this.slots)
			if ("settledAt" in slot && slot.settledAt < oldest) this.slots.delete(opId);
	}

	/** Settled answers leave oldest first; an op still running is never forgotten (its repeat must join it). */
	private trim(): void {
		for (const [opId, slot] of this.slots) {
			if (this.slots.size <= MACHINE_OP_CACHE_MAX_ENTRIES) return;
			if ("settledAt" in slot) this.slots.delete(opId);
		}
	}
}
