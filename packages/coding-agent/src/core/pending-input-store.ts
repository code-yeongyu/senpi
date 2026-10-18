import { reducePendingInput } from "./pending-input.ts";
import { type PendingInputProjection, projectPendingInput } from "./pending-input-projection.ts";
import type {
	DeliveryToken,
	PendingInput,
	PendingInputEvent,
	PendingInputHandle,
	PendingInputOperationResult,
	SubmitEvent,
} from "./pending-input-types.ts";

export const PENDING_INPUT_TRANSITION = "pending_input_transition";

/** One complete, durable transition: the input after it and the answer it gave, appended before anything else. */
export interface PendingInputJournalRecord {
	readonly type: typeof PENDING_INPUT_TRANSITION;
	readonly cursor: number;
	readonly input: PendingInput;
	readonly result?: PendingInputOperationResult;
}

export interface PendingInputJournal {
	append(record: PendingInputJournalRecord): Promise<void>;
	read(): Promise<readonly PendingInputJournalRecord[]>;
}

export interface PendingInputStoreOptions {
	readonly journal: PendingInputJournal;
	readonly lifetimeId: string;
	readonly nextQueuedId: () => string;
	readonly dispatch?: (token: DeliveryToken, input: PendingInput) => void;
	readonly restoreToDraft?: (text: string) => void;
	/**
	 * Receives a listener's throw; an owner should always supply it, since the default rethrow is uncaught. A committed transition is not undone by a failing observer, and its dispatch
	 * still runs; by default the error is rethrown on a later microtask so it is never silently lost.
	 */
	readonly onListenerError?: (error: unknown) => void;
}

export type PendingInputListener = (projection: PendingInputProjection) => void;

export type PendingInputRead =
	| { readonly status: "admitted"; readonly projection: PendingInputProjection }
	| { readonly status: "not_admitted"; readonly clientMessageId: string };

export interface StopItem {
	readonly clientMessageId: string;
	readonly handle: PendingInputHandle;
	readonly expectedRevision: number;
}

export interface StopReceipt {
	readonly removed: readonly string[];
	readonly conflicts: readonly { readonly clientMessageId: string; readonly currentRevision: number }[];
	readonly retained: readonly string[];
	/** Named with a handle of another lifetime or queue slot: the caller saw another version and must refresh. */
	readonly stale: readonly string[];
}

/** The one owner of every pending input in a session: reduce, commit, then publish and dispatch (senpi#3549). */
export class PendingInputStore {
	private readonly inputs = new Map<string, PendingInput>();
	private readonly listeners = new Set<PendingInputListener>();
	private gate: Promise<unknown> = Promise.resolve();
	private cursor = 0;
	private unavailable: Error | undefined;
	private readonly options: PendingInputStoreOptions;

	private constructor(options: PendingInputStoreOptions) {
		this.options = options;
	}

	/** Rebuilds from the complete journal, then gives every still-pending input a handle of this lifetime. */
	static async open(options: PendingInputStoreOptions): Promise<PendingInputStore> {
		const store = new PendingInputStore(options);
		for (const record of await options.journal.read()) {
			store.inputs.set(record.input.clientMessageId, record.input);
			store.cursor = Math.max(store.cursor, record.cursor);
		}
		for (const input of [...store.inputs.values()]) {
			if (input.phase === "delivered" || input.phase === "removed") continue;
			const handle = { lifetimeId: options.lifetimeId, queuedId: options.nextQueuedId() };
			await store.commit(input.clientMessageId, { type: "rebind", handle });
		}
		return store;
	}

	submit(event: Omit<SubmitEvent, "type" | "handle">): Promise<PendingInputOperationResult | undefined> {
		return this.serialize(() => {
			const handle = this.inputs.get(event.clientMessageId)?.handle ?? {
				lifetimeId: this.options.lifetimeId,
				queuedId: this.options.nextQueuedId(),
			};
			return this.commit(event.clientMessageId, { ...event, type: "submit", handle });
		});
	}

	apply(
		clientMessageId: string,
		event: Exclude<PendingInputEvent, SubmitEvent>,
	): Promise<PendingInputOperationResult | undefined> {
		return this.serialize(() => this.commit(clientMessageId, event));
	}

	/** Explicit Stop over the inputs the caller saw: each named revision is removed or reported, never guessed. */
	stop(items: readonly StopItem[], consumerFenced: boolean): Promise<StopReceipt> {
		return this.serialize(async () => {
			const removed: string[] = [];
			const retained: string[] = [];
			const conflicts: { clientMessageId: string; currentRevision: number }[] = [];
			const stale: string[] = [];
			for (const item of items) {
				const current = this.inputs.get(item.clientMessageId);
				if (current === undefined) continue;
				// Revisions restart at 1 on every reopen, so the handle decides which version the caller saw.
				if (!sameHandle(current.handle, item.handle)) {
					stale.push(item.clientMessageId);
					continue;
				}
				if (current.phase === "queued" && current.revision !== item.expectedRevision) {
					conflicts.push({ clientMessageId: item.clientMessageId, currentRevision: current.revision });
					continue;
				}
				await this.commit(item.clientMessageId, { type: "cancel", cause: "stop", consumerFenced });
				const after = this.inputs.get(item.clientMessageId);
				if (after?.phase === "removed" && current.phase !== "removed") removed.push(item.clientMessageId);
				else retained.push(item.clientMessageId);
			}
			return { removed, conflicts, retained, stale };
		});
	}

	read(clientMessageId: string): PendingInputRead {
		const input = this.inputs.get(clientMessageId);
		return input === undefined
			? { status: "not_admitted", clientMessageId }
			: { status: "admitted", projection: projectPendingInput(input) };
	}

	snapshot(): readonly PendingInputProjection[] {
		return [...this.inputs.values()].map(projectPendingInput);
	}

	subscribe(listener: PendingInputListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const guarded = () => {
			if (this.unavailable !== undefined)
				return Promise.reject(new PendingInputStoreUnavailableError(this.unavailable));
			return operation();
		};
		const run = this.gate.then(guarded, guarded);
		this.gate = run.catch(() => undefined);
		return run;
	}

	private async commit(
		clientMessageId: string,
		event: PendingInputEvent,
	): Promise<PendingInputOperationResult | undefined> {
		const current = this.inputs.get(clientMessageId);
		const decision = reducePendingInput(current, event);
		const next = decision.next;
		const result =
			decision.result?.clientMessageId === "" ? { ...decision.result, clientMessageId } : decision.result;
		if (next === undefined || decision.effects.length === 0) return result;
		const record: PendingInputJournalRecord = {
			type: PENDING_INPUT_TRANSITION,
			cursor: this.cursor + 1,
			input: next,
			...(result === undefined ? {} : { result }),
		};
		try {
			await this.options.journal.append(record);
		} catch (error) {
			// A write that may have landed cannot be retried at the same cursor, or the next reopen would see a gap:
			// stop accepting commands until a reopen rebuilds the store from what the file actually holds.
			if (isUncertainAppend(error)) this.unavailable = error;
			throw error;
		}
		this.cursor = record.cursor;
		this.inputs.set(clientMessageId, next);
		const projection = projectPendingInput(next);
		for (const listener of this.listeners) {
			try {
				listener(projection);
			} catch (error) {
				this.reportListenerError(error);
			}
		}
		for (const effect of decision.effects) {
			if (effect.type === "dispatch") this.options.dispatch?.(effect.token, next);
			if (effect.type === "restore_to_draft") this.options.restoreToDraft?.(effect.text);
		}
		return result;
	}

	private reportListenerError(error: unknown): void {
		const report = this.options.onListenerError;
		if (report !== undefined) report(error);
		else
			queueMicrotask(() => {
				throw error;
			});
	}
}

function isUncertainAppend(error: unknown): error is Error {
	return error instanceof Error && "code" in error && error.code === "pending_input_append_uncertain";
}

/** A previous write may have landed without being synced; only a reopen can say what the journal holds. */
export class PendingInputStoreUnavailableError extends Error {
	readonly code = "pending_input_store_unavailable";
	constructor(cause: Error) {
		super("Pending inputs are unavailable after a failed save; reopen the session to recover them.", { cause });
		this.name = "PendingInputStoreUnavailableError";
	}
}

function sameHandle(left: PendingInputHandle, right: PendingInputHandle): boolean {
	return left.lifetimeId === right.lifetimeId && left.queuedId === right.queuedId;
}
