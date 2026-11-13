import { serializeJsonLine } from "./jsonl.ts";
import { GeneratedFramesCursor } from "./legacy-view-cursor.ts";
import type { EventLease } from "./compact-recovery-types.ts";

/**
 * Identity first, then a pageable checkpoint identity, in one installed actor barrier. A baseline that ends before it
 * handed its answer to the queue tells the answer's owner, which then writes the answer the ordinary way (senpi#6587).
 */
export function admissionBaseline(
	reply: Promise<Readonly<Record<string, unknown>> | undefined>,
	identity: {
		readonly sessionId: string;
		readonly admissionId: string;
		readonly generation: number;
		readonly token?: string;
		readonly eventLease?: EventLease;
		readonly componentRef?: string;
	},
	live: () => boolean,
	routes?: readonly string[],
): GeneratedFramesCursor {
	// The baseline finds the object its answer is handed over through by the promise it was given.
	const owner = owners.get(reply);
	let handedOut = false;
	return new GeneratedFramesCursor(
		false,
		async function* () {
			const answer = await reply;
			if (answer === undefined) return;
			// From here the queue holds the answer's line and writes it; before, this baseline wrote nothing.
			handedOut = true;
			yield serializeJsonLine(answer);
			if (live())
				for (const admissionId of routes ?? [identity.admissionId])
					yield serializeJsonLine({
						type: "recovery_manifest",
						...identity,
						admissionId,
						componentRef: identity.componentRef ?? "manifest",
					});
		},
		() => {
			if (!handedOut) owner?.ended();
		},
	);
}

type Answer = Readonly<Record<string, unknown>>;

/** The baseline of an answer finds its owner here; only this module reads it. */
const owners = new WeakMap<Promise<Answer | undefined>, BaselineAnswer>();

/**
 * The one answer of a request that is written through an admission baseline. The baseline is written later by the
 * connection's queue, outside the place that takes a host's other answers, and it can end without having written the
 * answer: the queue takes no baseline while a recovery drops records, and an overflow drops every baseline already
 * queued (senpi#6587). So the answer goes one of two ways, and exactly one. Handed to a baseline the queue took and
 * still holds, it is noted as the request's answer. When the baseline ended before it handed the answer to the queue,
 * the answer is written the ordinary way, as any reply is.
 */
export class BaselineAnswer {
	readonly #reply = Promise.withResolvers<Answer | undefined>();
	readonly #note: (answer: Answer) => void;
	readonly #write: (answer: Answer) => boolean;
	#queued: boolean | undefined;
	#ended = false;
	#handed = false;
	#answer: Answer | undefined;
	#ordinary = false;
	#taken = false;

	/** `note` tells the writer of an answer a baseline will write; `write` writes one the ordinary way and answers whether it was taken. */
	constructor(note: (answer: Answer) => void, write: (answer: Answer) => boolean) {
		this.#note = note;
		this.#write = write;
		owners.set(this.#reply.promise, this);
	}

	/** What the baseline writes first: the answer once it is handed over, or nothing. */
	get answer(): Promise<Answer | undefined> {
		return this.#reply.promise;
	}

	/** Installs the baseline once; `queue` answers whether the connection took it. */
	install(queue: () => boolean): void {
		this.#queued ??= queue();
	}

	/** Hands the answer over, or with `undefined` ends the baseline with nothing to write. Only the first call counts. */
	hand(answer: Answer | undefined): void {
		if (this.#handed) return;
		this.#handed = true;
		this.#answer = answer;
		if (answer !== undefined) {
			if (this.#queued === true && !this.#ended) {
				this.#taken = true;
				this.#note(answer);
			} else this.#writeOrdinary();
		}
		this.#reply.resolve(answer);
	}

	/** Told by the baseline when it ended before it handed the answer to the queue: it wrote nothing. */
	ended(): void {
		if (this.#ended) return;
		this.#ended = true;
		// A baseline can end inside the queue's own cut, which is replacing its entries: the answer goes in after it.
		if (this.#answer !== undefined) queueMicrotask(() => this.#writeOrdinary());
	}

	/** Whether the request's answer was taken for writing, by a baseline or the ordinary way. */
	get taken(): boolean {
		return this.#taken;
	}

	#writeOrdinary(): void {
		if (this.#ordinary || this.#answer === undefined) return;
		this.#ordinary = true;
		if (this.#write(this.#answer)) this.#taken = true;
	}
}
