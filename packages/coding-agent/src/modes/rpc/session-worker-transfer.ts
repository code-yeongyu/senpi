import type { CompactProducerStamp } from "./compact-producer-stamp.ts";
import { FRAGMENT_MAX_BYTES } from "./compact-recovery-bytes.ts";
import { WorkerPermitGate } from "./session-worker-permits.ts";
import { SESSION_WORKER_LIMITS, type SessionWorkerToHost } from "./session-worker-protocol.ts";

/** Code units one fragment carries: D stored bytes (R4.B3), two per UTF-16 code unit, as S12a's staging stores them. */
const FRAGMENT_UNITS = FRAGMENT_MAX_BYTES / 2;
const withoutSignals = (_key: string, value: unknown): unknown =>
	value instanceof SharedArrayBuffer ? undefined : value;

/**
 * The worker half of the payload transport (S12b; RULING-63 Q3, RULING-64). Every bootstrap, output, snapshot and
 * canonical message is built only after this isolate holds a host permit, and one permit pays for one physical frame.
 * A message whose JSON fits one fragment is posted as it is; a larger one travels as fragments of at most D stored bytes
 * of that JSON, each paid for by its own permit. In the ordered stream every fragment takes the next physical ordinal
 * and the final fragment is the commit frame: it carries the message's own ordinal, binding and signals.
 */
export class WorkerTransfer {
	private readonly post: (message: SessionWorkerToHost) => void;
	private readonly gate: WorkerPermitGate;
	private readonly stamp: CompactProducerStamp;
	private readonly fail: (error: string) => never;
	/** A permit taken for a message whose builder threw: only the host adds credit, so the next message spends it. */
	private spare = false;

	constructor(
		post: (message: SessionWorkerToHost) => void,
		block: SharedArrayBuffer,
		stamp: CompactProducerStamp,
		fail: (error: string) => never,
	) {
		this.post = post;
		this.gate = new WorkerPermitGate(block, SESSION_WORKER_LIMITS.controlMs);
		this.stamp = stamp;
		this.fail = fail;
	}

	send(build: () => SessionWorkerToHost): void {
		this.take();
		let message: SessionWorkerToHost;
		try {
			message = build();
		} catch (cause) {
			this.spare = true;
			throw cause;
		}
		const text = JSON.stringify(message, withoutSignals);
		if (text.length <= FRAGMENT_UNITS) {
			this.post(message);
			return;
		}
		const count = Math.ceil(text.length / FRAGMENT_UNITS);
		const commit = "ordinal" in message && message.ordinal !== undefined ? this.stamp.defer(count - 1) : undefined;
		const epochSignal = "bootstrap" in message ? message.bootstrap?.epochSignal : undefined;
		for (let index = 0; index < count; index += 1) {
			if (index > 0) this.take();
			const last = index === count - 1;
			this.post({
				type: "fragment",
				of: message.type,
				length: text.length * 2,
				offset: index * FRAGMENT_UNITS * 2,
				text: text.slice(index * FRAGMENT_UNITS, (index + 1) * FRAGMENT_UNITS),
				...(commit ? { ordinal: commit.ordinal - (count - 1 - index) } : {}),
				...(last && commit?.firstOrdinal !== undefined ? { firstOrdinal: commit.firstOrdinal } : {}),
				...(last && "signal" in message ? { signal: message.signal } : {}),
				...(last && epochSignal ? { epochSignal } : {}),
			});
		}
	}

	/** A closed host ends the isolate cleanly; a deny that never cleared, or no answer, is a typed worker failure. */
	private take(): void {
		if (this.spare) {
			this.spare = false;
			return;
		}
		const outcome = this.gate.acquire();
		if (outcome === "closed") process.exit(0);
		if (outcome !== "granted") this.fail(`session_worker_permit_${outcome}`);
	}
}
