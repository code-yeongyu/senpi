import { FRAGMENT_ENVELOPE_MAX_BYTES } from "./compact-recovery-bytes.ts";
import { TRANSFER_STAGING_MAX_BYTES } from "./compact-transfer-staging.ts";

/**
 * One payload permit, and the fixed initial credit of every permit block: ONE S11 page envelope in bytes (RULING-63 Q3,
 * RULING-69 (1)), derived from the page budget, never a second literal. One permit pays for one physical frame of at
 * most D stored payload bytes, which the envelope always covers.
 */
export const WORKER_PERMIT_BYTES = FRAGMENT_ENVELOPE_MAX_BYTES;
/** Ledger slots kept for control progress: data permits never take them (S12 design section 3, RULING-80 (1)). */
export const WORKER_CONTROL_SLOTS = 1;

/**
 * The Int32 words of a permit block (RULING-63 Q3 (1)): `credit` bytes, which only the host adds to and only the worker
 * takes from; the host's tagged word (granted, denied, closed), which only the host writes; the worker's tagged word
 * (idle, waiting), which only the worker writes; and `wake`, a count only the host adds to on every signal, the one
 * word the worker waits on (#5591). Every read is an `Atomics.load`.
 */
export const PERMIT_WORD = { credit: 0, host: 1, worker: 2, wake: 3 } as const;
/** The size of one permit block: one Int32 per word of {@link PERMIT_WORD}. */
export const PERMIT_BLOCK_BYTES = Object.keys(PERMIT_WORD).length * Int32Array.BYTES_PER_ELEMENT;
export const PERMIT_TAG = { idle: 0, granted: 1, denied: 2, closed: 3, waiting: 4 } as const;

/** How one permit request ended; anything but `granted` leaves the worker with no payload built. */
export type PermitOutcome = "granted" | "denied" | "timeout" | "closed";

/**
 * The host's payload capacity for every session worker (S12 design section 3): B_worker bytes in whole permits, one of
 * them kept for control progress, so data frames never take the room the bounded control exchanges (write
 * reservations, capabilities, results, failures) travel in. A request past the ceiling is refused before anything is
 * allocated and queued; a release hands its permit to the oldest queued request.
 */
export class WorkerPermitLedger {
	readonly ceiling: number;
	private granted = 0;
	private readonly waiting = new Set<() => void>();

	constructor(capacity = TRANSFER_STAGING_MAX_BYTES) {
		this.ceiling = Math.floor(capacity / WORKER_PERMIT_BYTES) - WORKER_CONTROL_SLOTS;
	}

	request(grant: () => void): boolean {
		if (this.granted >= this.ceiling) {
			this.waiting.add(grant);
			return false;
		}
		this.granted += 1;
		grant();
		return true;
	}

	release(): void {
		this.granted -= 1;
		const [next] = this.waiting;
		if (!next) return;
		this.waiting.delete(next);
		this.granted += 1;
		next();
	}

	withdraw(grant: () => void): void {
		this.waiting.delete(grant);
	}

	status(): { readonly granted: number; readonly waiting: number; readonly ceiling: number } {
		return { granted: this.granted, waiting: this.waiting.size, ceiling: this.ceiling };
	}
}

/** The one ledger of this host process, shared by every worker it starts (never one per worker). */
export const hostWorkerPermits = new WorkerPermitLedger();

/**
 * The host half of one worker incarnation's permit block. It grants or denies before the worker builds any payload,
 * also while that worker is blocked in `Atomics.wait`, and holds at most one permit for it: granted and unspent, or
 * spent on the one frame in flight.
 */
export class HostPermits {
	readonly block = new SharedArrayBuffer(PERMIT_BLOCK_BYTES);
	private readonly state = new Int32Array(this.block);
	private readonly ledger: WorkerPermitLedger;
	private holding = false;
	private closed = false;
	private readonly grant = (): void => {
		this.holding = true;
		Atomics.add(this.state, PERMIT_WORD.credit, WORKER_PERMIT_BYTES);
		this.signal(PERMIT_TAG.granted);
	};

	constructor(ledger: WorkerPermitLedger) {
		this.ledger = ledger;
		this.request();
	}

	/** The worker spent its permit on a frame the host now holds: the capacity returns and the next permit follows. */
	returned(): void {
		if (this.closed || !this.holding || Atomics.load(this.state, PERMIT_WORD.credit) >= WORKER_PERMIT_BYTES) return;
		this.holding = false;
		this.ledger.release();
		this.request();
	}

	/** Wakes every waiter with `closed`; the held permit, or the queued request, leaves the ledger exactly once. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.signal(PERMIT_TAG.closed);
		if (this.holding) this.ledger.release();
		else this.ledger.withdraw(this.grant);
		this.holding = false;
	}

	private request(): void {
		if (!this.ledger.request(this.grant)) this.signal(PERMIT_TAG.denied);
	}

	/**
	 * Every signal changes `wake` after its own writes, so a worker that read `wake` before deciding to wait sees the
	 * change when its wait starts, even if the notify ran before the worker was parked (#5591).
	 */
	private signal(tag: number): void {
		Atomics.store(this.state, PERMIT_WORD.host, tag);
		Atomics.add(this.state, PERMIT_WORD.wake, 1);
		Atomics.notify(this.state, PERMIT_WORD.wake);
	}
}

/**
 * The worker half of a permit block: takes one permit before the worker builds any payload. The wait loops, re-checking
 * after every wake, until a permit is taken, the host closes, or the deadline passes (RULING-63 Q3 (2)). A deny keeps
 * the request alive, so a later grant still ends the wait (recoverable); it only names the outcome at the deadline.
 * Each pass reads `wake` first and waits on that value, so a host signal between the checks and the wait ends it.
 */
export class WorkerPermitGate {
	private readonly state: Int32Array;
	private readonly timeoutMs: number;

	constructor(block: SharedArrayBuffer, timeoutMs: number) {
		// RULING-63 Q3a: host and worker share one block layout; a block of any other size is never attached.
		if (block.byteLength !== PERMIT_BLOCK_BYTES)
			throw new Error(`permit block is ${block.byteLength} bytes, expected ${PERMIT_BLOCK_BYTES}`);
		this.state = new Int32Array(block);
		this.timeoutMs = timeoutMs;
	}

	acquire(): PermitOutcome {
		const deadline = performance.now() + this.timeoutMs;
		try {
			for (;;) {
				const wake = Atomics.load(this.state, PERMIT_WORD.wake);
				if (Atomics.load(this.state, PERMIT_WORD.host) === PERMIT_TAG.closed) return "closed";
				const credit = Atomics.load(this.state, PERMIT_WORD.credit);
				if (credit >= WORKER_PERMIT_BYTES) {
					const taken = Atomics.compareExchange(
						this.state,
						PERMIT_WORD.credit,
						credit,
						credit - WORKER_PERMIT_BYTES,
					);
					if (taken === credit) return "granted";
					continue;
				}
				const left = deadline - performance.now();
				if (left <= 0)
					return Atomics.load(this.state, PERMIT_WORD.host) === PERMIT_TAG.denied ? "denied" : "timeout";
				this.mark(PERMIT_TAG.waiting);
				Atomics.wait(this.state, PERMIT_WORD.wake, wake, left);
			}
		} finally {
			this.mark(PERMIT_TAG.idle);
		}
	}

	private mark(tag: number): void {
		Atomics.store(this.state, PERMIT_WORD.worker, tag);
		Atomics.notify(this.state, PERMIT_WORD.worker);
	}
}
