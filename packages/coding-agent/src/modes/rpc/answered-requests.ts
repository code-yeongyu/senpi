/**
 * Which requests in flight already had an answer taken for writing, so the one place that answers a handler's throw
 * (`answerLine`) does not give a request a second answer (senpi#6483's review).
 *
 * A request is watched from the dispatch of its line until that line is done, and no longer. The set therefore holds
 * the lines in flight and nothing else: it cannot grow on a long-lived connection, and an id that a later line uses
 * again on the same connection starts unanswered.
 */
export interface AnswerWatch {
	/** Whether the writer took a response under the watched id for the watched connection since the watch began. */
	answered(): boolean;
	/** Ends the watch. Called once the line is done, however it ended. */
	done(): void;
}

const UNWATCHED: AnswerWatch = { answered: () => false, done: () => {} };
const keyOf = (connection: string | undefined, id: string): string => `${connection ?? ""}\u0000${id}`;

function responseId(value: object): string | undefined {
	if (!("type" in value) || value.type !== "response" || !("id" in value)) return undefined;
	return typeof value.id === "string" ? value.id : undefined;
}

export class AnsweredRequests {
	readonly #watching = new Map<string, Set<{ answered: boolean }>>();

	/** Watches one request. A request sent without an id is owed no answer and is not watched. */
	watch(connection: string | undefined, id: string | undefined): AnswerWatch {
		if (id === undefined) return UNWATCHED;
		const key = keyOf(connection, id);
		const watchers = this.#watching.get(key) ?? new Set();
		const state = { answered: false };
		watchers.add(state);
		this.#watching.set(key, watchers);
		return {
			answered: () => state.answered,
			done: () => {
				watchers.delete(state);
				if (watchers.size === 0) this.#watching.delete(key);
			},
		};
	}

	/** Told by the writer of each value it took into a queue for `connection`; a value it refused is never told. */
	taken(connection: string | undefined, value: object): void {
		if (this.#watching.size === 0) return;
		const id = responseId(value);
		if (id === undefined) return;
		for (const state of this.#watching.get(keyOf(connection, id)) ?? []) state.answered = true;
	}
}
