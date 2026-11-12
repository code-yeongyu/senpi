import { serializeJsonLine } from "./jsonl.ts";
import { GeneratedFramesCursor } from "./legacy-view-cursor.ts";
import type { EventLease } from "./compact-recovery-types.ts";

/** Identity first, then a pageable checkpoint identity, in one installed actor barrier. */
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
	return new GeneratedFramesCursor(
		false,
		async function* () {
			const answer = await reply;
			if (answer === undefined) return;
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
		() => {},
	);
}

type Answer = Readonly<Record<string, unknown>>;

/**
 * The one answer of a request that is written through an admission baseline. The baseline is written later by the
 * connection, outside the place that takes a host's other answers, so the hand-over is where the writer learns that
 * the request was answered: an answer handed to a baseline the connection took is noted, and one handed to a baseline
 * it did not take (or to none) is not, since nothing will write it.
 */
export class BaselineAnswer {
	readonly #reply = Promise.withResolvers<Answer | undefined>();
	readonly #note: (answer: Answer) => void;
	#queued: boolean | undefined;
	#taken = false;

	constructor(note: (answer: Answer) => void) {
		this.#note = note;
	}

	/** What the baseline writes first: the answer once it is handed over, or nothing. */
	get answer(): Promise<Answer | undefined> {
		return this.#reply.promise;
	}

	/** Installs the baseline once; `queue` answers whether the connection took it. */
	install(queue: () => boolean): void {
		this.#queued ??= queue();
	}

	/** Hands the answer over, or with `undefined` ends the baseline with nothing to write. */
	hand(answer: Answer | undefined): void {
		if (answer !== undefined && this.#queued === true && !this.#taken) {
			this.#taken = true;
			this.#note(answer);
		}
		this.#reply.resolve(answer);
	}

	/** Whether an answer was handed to a baseline the connection took. */
	get taken(): boolean {
		return this.#taken;
	}
}
