import { LOSSY_FRAME_TYPES, TOOL_CHILD_LIMITS, type ToolChildMessage, type ToolChildMessageOf } from "./protocol.ts";

export class WakeAdmissionError extends Error {
	readonly code = "wake_too_large";
	constructor(bytes: number) {
		super(`wake_too_large: ${bytes} bytes exceeds the ${TOOL_CHILD_LIMITS.wakePendingBytes}-byte pending budget`);
		this.name = "WakeAdmissionError";
	}
}

interface BlockedWake {
	wakeId: string;
	bytes: number;
	release: () => void;
}

/**
 * Wake notifications awaiting `wake_ack`, bounded by count and summed bytes. A wake past either bound waits, FIFO,
 * until an ack frees room: wakes are durable wake-source demand and are never dropped.
 */
export class WakeAdmission {
	readonly #pending = new Map<string, number>();
	readonly #blocked: BlockedWake[] = [];
	#pendingBytes = 0;

	get pending(): number {
		return this.#pending.size;
	}

	get blocked(): number {
		return this.#blocked.length;
	}

	send(wakeId: string, bytes: number): Promise<void> {
		if (bytes > TOOL_CHILD_LIMITS.wakePendingBytes) return Promise.reject(new WakeAdmissionError(bytes));
		if (this.#blocked.length === 0 && this.#fits(bytes)) {
			this.#admit(wakeId, bytes);
			return Promise.resolve();
		}
		return new Promise((release) => {
			this.#blocked.push({ wakeId, bytes, release });
		});
	}

	ack(wakeId: string): void {
		const bytes = this.#pending.get(wakeId);
		if (bytes === undefined) return;
		this.#pending.delete(wakeId);
		this.#pendingBytes -= bytes;
		for (let next = this.#blocked[0]; next !== undefined && this.#fits(next.bytes); next = this.#blocked[0]) {
			this.#blocked.shift();
			this.#admit(next.wakeId, next.bytes);
			next.release();
		}
	}

	#fits(bytes: number): boolean {
		return (
			this.#pending.size < TOOL_CHILD_LIMITS.wakePending &&
			this.#pendingBytes + bytes <= TOOL_CHILD_LIMITS.wakePendingBytes
		);
	}

	#admit(wakeId: string, bytes: number): void {
		this.#pending.set(wakeId, bytes);
		this.#pendingBytes += bytes;
	}
}

/** Per-second budget for `trace` frames, the only lossy class: an over-budget frame is dropped and counted. */
export class TraceBudget {
	#second = Number.NaN;
	#admitted = 0;
	#dropped = 0;

	get dropped(): number {
		return this.#dropped;
	}

	admit(_frame: ToolChildMessageOf<"trace">, nowMs: number): boolean {
		const second = Math.floor(nowMs / 1000);
		if (second !== this.#second) {
			this.#second = second;
			this.#admitted = 0;
		}
		if (this.#admitted >= TOOL_CHILD_LIMITS.tracePerSecond) {
			this.#dropped += 1;
			return false;
		}
		this.#admitted += 1;
		return true;
	}
}

export function isLossy(message: ToolChildMessage): boolean {
	return LOSSY_FRAME_TYPES.has(message.type);
}
