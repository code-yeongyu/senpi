/**
 * A child job's streamed updates (senpi#3566 todo 9): `update(value)` sends the job's next partial result in order,
 * by acknowledged reference when large, and waits for credit once `updatesInFlight` are unacknowledged - so a fast
 * producer is paced by the server instead of buffering without bound, and no update is ever dropped.
 */
import type { ToolChildChannel } from "./channel.ts";
import type { PayloadRefWriter } from "./payload-ref.ts";
import { packPayload } from "./payload-wire.ts";
import { TOOL_CHILD_LIMITS } from "./protocol.ts";

export class JobUpdates {
	readonly #jobId: string;
	readonly #channel: Pick<ToolChildChannel, "send">;
	readonly #writer: PayloadRefWriter | undefined;
	readonly #window: number;
	#nextSeq = 0;
	#acked = 0;
	#waiters: Array<() => void> = [];
	#ended = false;
	/** The previous update's send: updates go out in call order, each packed before it takes its seq. */
	#tail: Promise<void> = Promise.resolve();

	constructor(options: {
		readonly jobId: string;
		readonly channel: Pick<ToolChildChannel, "send">;
		readonly writer?: PayloadRefWriter;
		readonly window?: number;
	}) {
		this.#jobId = options.jobId;
		this.#channel = options.channel;
		this.#writer = options.writer;
		this.#window = options.window ?? TOOL_CHILD_LIMITS.updatesInFlight;
	}

	/** Sends the next update once a credit is free, after every earlier one; rejects after the job ended. */
	update(value: unknown): Promise<void> {
		const sent = this.#tail.then(() => this.#send(value));
		this.#tail = sent.catch(() => undefined);
		return sent;
	}

	async #send(value: unknown): Promise<void> {
		while (!this.#ended && this.#nextSeq - this.#acked >= this.#window)
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		if (this.#ended) throw new Error(`update after job ${this.#jobId} ended`);
		const packed =
			this.#writer === undefined ? { inline: true as const, value } : await packPayload(value, this.#writer);
		if (this.#ended) throw new Error(`update after job ${this.#jobId} ended`);
		const seq = ++this.#nextSeq;
		this.#channel.send(
			packed.inline
				? {
						type: "update",
						jobId: this.#jobId,
						seq,
						...(packed.value === undefined ? {} : { value: packed.value }),
					}
				: { type: "update", jobId: this.#jobId, seq, valueRef: packed.ref },
		);
	}

	/** The server delivered update `seq`: every update up to it holds no credit any more. */
	acked(seq: number): void {
		if (seq <= this.#acked) return;
		this.#acked = Math.min(seq, this.#nextSeq);
		this.#wake();
	}

	/** The job ended: waiting producers are released and further updates refused. */
	end(): void {
		this.#ended = true;
		this.#wake();
	}

	#wake(): void {
		for (const resolve of this.#waiters.splice(0)) resolve();
	}
}
