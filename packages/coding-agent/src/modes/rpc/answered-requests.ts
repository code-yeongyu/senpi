/**
 * Which requests in flight already had an answer taken for writing, so the one place that answers a handler's throw
 * (`answerLine`) does not give a request a second answer (senpi#6483's review).
 *
 * A request is watched from the dispatch of its line until that line is done, and no longer. The ledger keeps the
 * watches themselves and nothing else, so there is nothing a finished line can leave behind: it does not grow on a
 * long-lived connection, and an id that a later line uses again on the same connection starts unanswered.
 */
export interface AnswerWatch {
	/** Whether the writer took a response under the watched id for the watched connection since the watch began. */
	answered(): boolean;
	/** Ends the watch. Called once the line is done, however it ended. */
	done(): void;
}

interface Watching {
	readonly connection: string | undefined;
	readonly id: string;
	answered: boolean;
}

const UNWATCHED: AnswerWatch = { answered: () => false, done: () => {} };

function responseId(value: object): string | undefined {
	if (!("type" in value) || value.type !== "response" || !("id" in value)) return undefined;
	return typeof value.id === "string" ? value.id : undefined;
}

export class AnsweredRequests {
	readonly #watching = new Set<Watching>();

	/** Watches one request. A request sent without an id is owed no answer and is not watched. */
	watch(connection: string | undefined, id: string | undefined): AnswerWatch {
		if (id === undefined) return UNWATCHED;
		const watching: Watching = { connection, id, answered: false };
		this.#watching.add(watching);
		return {
			answered: () => watching.answered,
			done: () => {
				this.#watching.delete(watching);
			},
		};
	}

	/** Told by the writer of each value it took into a queue for `connection`; a value it refused is never told. */
	taken(connection: string | undefined, value: object): void {
		if (this.#watching.size === 0) return;
		const id = responseId(value);
		if (id === undefined) return;
		for (const watching of this.#watching)
			if (watching.connection === connection && watching.id === id) watching.answered = true;
	}
}
