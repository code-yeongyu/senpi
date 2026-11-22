type QueuedDisposition = "queued" | "started";

interface Tracked {
	readonly inputId: string;
	phase: "queued-pending" | "queued" | "delivered";
}

/**
 * The `input_disposition` events of input queued while a turn runs: `queued` once it waits in the queue, then
 * `started` when its user message is delivered into a turn (senpi#4482). `started` never precedes `queued`: a
 * message delivered before its `queued` event finished is reported right after it.
 */
export class QueuedInputDispositions {
	readonly #byMessage = new WeakMap<object, Tracked>();
	readonly #awaitingQueued = new Map<string, Tracked>();
	readonly #emit: (inputId: string, disposition: QueuedDisposition) => Promise<void>;

	constructor(emit: (inputId: string, disposition: QueuedDisposition) => Promise<void>) {
		this.#emit = emit;
	}

	track(message: object, inputId: string): void {
		const tracked: Tracked = { inputId, phase: "queued-pending" };
		this.#byMessage.set(message, tracked);
		this.#awaitingQueued.set(inputId, tracked);
	}

	async queued(inputId: string | undefined): Promise<void> {
		if (inputId === undefined) return;
		await this.#emit(inputId, "queued");
		const tracked = this.#awaitingQueued.get(inputId);
		this.#awaitingQueued.delete(inputId);
		if (tracked?.phase === "delivered") await this.#emit(inputId, "started");
		else if (tracked !== undefined) tracked.phase = "queued";
	}

	async delivered(message: object): Promise<void> {
		const tracked = this.#byMessage.get(message);
		if (tracked === undefined) return;
		this.#byMessage.delete(message);
		if (tracked.phase === "queued") await this.#emit(tracked.inputId, "started");
		else tracked.phase = "delivered";
	}
}
