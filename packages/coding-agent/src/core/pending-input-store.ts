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
	/** Further inputs changed in the same step (a consumer's batch), recorded atomically with `input`. */
	readonly batch?: readonly PendingInput[];
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
	/** Reconciles native custody after an uncertain append has been replayed and synced, under the gate. */
	readonly onRecovered?: (inputs: readonly PendingInput[]) => void;
	/** The owner sends only after consumption resolves: reopen rebinds, and recovery releases rejected consumption. */
	readonly uncommittedAttemptsAreUnsent?: boolean;
	/**
	 * Receives a listener's throw; an owner should always supply it, since the default rethrow is uncaught. A committed transition is not undone by a failing observer, and its dispatch
	 * still runs; by default the error is rethrown on a later microtask so it is never silently lost.
	 */
	readonly onListenerError?: (error: unknown) => void;
}

/** Called after each committed transition with its projection and the journal cursor it was written at. */
export type PendingInputListener = (projections: readonly PendingInputProjection[], cursor: number) => void;

/** Transitions inside one gated step: each is committed directly, since the caller already holds the gate. */
export interface PendingInputTransaction {
	submit(event: Omit<SubmitEvent, "type" | "handle">): Promise<PendingInputOperationResult | undefined>;
	apply(
		clientMessageId: string,
		event: Exclude<PendingInputEvent, SubmitEvent>,
	): Promise<PendingInputOperationResult | undefined>;
	/** Applies every change in one journal record: all of them land or none does. */
	applyAll(
		changes: readonly { readonly clientMessageId: string; readonly event: Exclude<PendingInputEvent, SubmitEvent> }[],
	): Promise<(PendingInputOperationResult | undefined)[]>;
	current(clientMessageId: string): PendingInput | undefined;
}

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
	private unsentConsumption: PendingInput[] = [];
	private recoveryEffects: (() => void) | undefined;
	private readonly options: PendingInputStoreOptions;

	private constructor(options: PendingInputStoreOptions) {
		this.options = options;
	}

	/** Rebuilds from the complete journal, then gives every still-pending input a handle of this lifetime. */
	static async open(options: PendingInputStoreOptions): Promise<PendingInputStore> {
		const store = new PendingInputStore(options);
		await store.rebuild();
		for (const input of [...store.inputs.values()]) {
			if (input.phase === "delivered" || input.phase === "removed") continue;
			const handle = { lifetimeId: options.lifetimeId, queuedId: options.nextQueuedId() };
			await store.commit(input.clientMessageId, {
				type: "rebind",
				handle,
				attemptsUnsent: options.uncommittedAttemptsAreUnsent === true,
			});
		}
		return store;
	}

	private async rebuild(recover = false): Promise<void> {
		const records = await this.options.journal.read();
		const inputs = new Map<string, PendingInput>();
		let cursor = 0;
		for (const record of records) {
			for (const input of [record.input, ...(record.batch ?? [])]) inputs.set(input.clientMessageId, input);
			cursor = Math.max(cursor, record.cursor);
		}
		const last = records.at(-1);
		let checkpoint: PendingInputJournalRecord | undefined;
		if (recover && last !== undefined) {
			const changes = new Map([last.input, ...(last.batch ?? [])].map((input) => [input.clientMessageId, input]));
			// A rejected consumption never reached the provider. Its landed record is corrected by a new
			// release record, using the live owner's pre-write witness, never by rewriting an old cursor.
			for (const previous of this.unsentConsumption) {
				if (inputs.get(previous.clientMessageId)?.phase !== "delivered" || previous.attempt === undefined) continue;
				const released = reducePendingInput(previous, { type: "release", token: previous.attempt }).next;
				if (released !== undefined) changes.set(previous.clientMessageId, released);
			}
			const [first, ...batch] = changes.values();
			if (first !== undefined) {
				checkpoint = {
					type: PENDING_INPUT_TRANSITION,
					cursor: cursor + 1,
					input: first,
					...(batch.length ? { batch } : {}),
				};
				// Reading an unsynced record is not durability. Even a replay/no-op command must pass this fence.
				await this.options.journal.append(checkpoint);
				cursor = checkpoint.cursor;
				for (const input of changes.values()) inputs.set(input.clientMessageId, input);
			}
		}
		this.inputs.clear();
		for (const [id, input] of inputs) this.inputs.set(id, input);
		this.cursor = cursor;
		if (!recover) return;
		this.unavailable = undefined;
		this.unsentConsumption = [];
		this.recoveryEffects = undefined;
		if (checkpoint !== undefined) this.publish([checkpoint.input, ...(checkpoint.batch ?? [])], checkpoint.cursor);
	}

	/**
	 * Only a failed replay or fence is `PendingInputStoreUnavailableError`. Once the journal is recovered, every
	 * reconciliation runs even when an earlier one throws, so a landed admission is always released, and each
	 * throw is reported as itself (senpi#4045 review).
	 */
	private async recover(): Promise<void> {
		const effects = this.recoveryEffects;
		try {
			await this.rebuild(true);
		} catch (error) {
			throw new PendingInputStoreUnavailableError(error);
		}
		const failures: unknown[] = [];
		for (const reconcile of [effects, () => this.options.onRecovered?.([...this.inputs.values()])]) {
			try {
				reconcile?.();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 1) throw new AggregateError(failures, "Pending-input recovery callbacks failed.");
		if (failures.length === 1) throw failures[0];
	}

	submit(event: Omit<SubmitEvent, "type" | "handle">): Promise<PendingInputOperationResult | undefined> {
		return this.serialize(() => this.admit(event));
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

	/**
	 * Runs `work` under the gate every command shares, so a consumer can change its native buffer and the
	 * journal in one step that no edit, removal or other consumer can interleave with.
	 */
	transaction<T>(work: (tx: PendingInputTransaction) => Promise<T>): Promise<T> {
		return this.serialize(() =>
			work({
				submit: (event) => this.admit(event),
				apply: (clientMessageId, event) => this.commit(clientMessageId, event),
				applyAll: (changes) => this.commitMany(changes),
				current: (clientMessageId) => this.inputs.get(clientMessageId),
			}),
		);
	}

	/** The full record of one input, for the session that owns this store. */
	current(clientMessageId: string): PendingInput | undefined {
		return this.inputs.get(clientMessageId);
	}

	read(clientMessageId: string): PendingInputRead {
		const input = this.inputs.get(clientMessageId);
		return input === undefined
			? { status: "not_admitted", clientMessageId }
			: { status: "admitted", projection: projectPendingInput(input) };
	}

	/** The cursor of the newest committed transition; a snapshot taken now covers everything through it. */
	get throughCursor(): number {
		return this.cursor;
	}

	snapshot(): readonly PendingInputProjection[] {
		return [...this.inputs.values()].map(projectPendingInput);
	}

	subscribe(listener: PendingInputListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const guarded = async () => {
			if (this.unavailable !== undefined) await this.recover();
			return operation();
		};
		const run = this.gate.then(guarded, guarded);
		this.gate = run.catch(() => undefined);
		return run;
	}

	private admit(event: Omit<SubmitEvent, "type" | "handle">): Promise<PendingInputOperationResult | undefined> {
		const handle = this.inputs.get(event.clientMessageId)?.handle ?? {
			lifetimeId: this.options.lifetimeId,
			queuedId: this.options.nextQueuedId(),
		};
		return this.commit(event.clientMessageId, { ...event, type: "submit", handle });
	}

	private async commit(
		clientMessageId: string,
		event: PendingInputEvent,
	): Promise<PendingInputOperationResult | undefined> {
		return (await this.commitMany([{ clientMessageId, event }]))[0];
	}

	/**
	 * Reduces every change, then records all that changed in ONE journal record, so a crash or a failed write
	 * keeps either all of them or none (a consumer committing a batch never sees half of it delivered).
	 */
	private async commitMany(
		changes: readonly { readonly clientMessageId: string; readonly event: PendingInputEvent }[],
	): Promise<(PendingInputOperationResult | undefined)[]> {
		const results: (PendingInputOperationResult | undefined)[] = [];
		const committed: { readonly next: PendingInput; readonly decision: ReturnType<typeof reducePendingInput> }[] = [];
		const staged = new Map<string, PendingInput>();
		const unsent: PendingInput[] = [];
		for (const { clientMessageId, event } of changes) {
			const current = staged.get(clientMessageId) ?? this.inputs.get(clientMessageId);
			const decision = reducePendingInput(current, event);
			const result =
				decision.result?.clientMessageId === "" ? { ...decision.result, clientMessageId } : decision.result;
			results.push(result);
			if (decision.next === undefined || decision.effects.length === 0) continue;
			if (
				this.options.uncommittedAttemptsAreUnsent &&
				event.type === "consumed" &&
				current?.phase === "sending" &&
				decision.next.phase === "delivered"
			)
				unsent.push(current);
			staged.set(clientMessageId, decision.next);
			committed.push({ next: decision.next, decision: { ...decision, result } });
		}
		const [first, ...rest] = committed;
		if (first === undefined) return results;
		const record: PendingInputJournalRecord = {
			type: PENDING_INPUT_TRANSITION,
			cursor: this.cursor + 1,
			input: first.next,
			...(first.decision.result === undefined ? {} : { result: first.decision.result }),
			...(rest.length === 0 ? {} : { batch: rest.map((entry) => entry.next) }),
		};
		try {
			await this.options.journal.append(record);
		} catch (error) {
			// A write that may have landed cannot be retried at the same cursor, or the next reopen would see a gap:
			// the next command rebuilds under this same gate before it may reduce or append anything.
			if (isUncertainAppend(error)) {
				this.unavailable = error;
				this.unsentConsumption = unsent;
				this.recoveryEffects = () => {
					for (const { next, decision } of committed) {
						const recovered = this.inputs.get(next.clientMessageId);
						for (const effect of decision.effects) {
							if (effect.type === "dispatch" && recovered?.attempt?.attemptId === effect.token.attemptId)
								this.options.dispatch?.(effect.token, recovered);
							if (effect.type === "restore_to_draft" && recovered?.phase === "removed")
								this.options.restoreToDraft?.(effect.text);
						}
					}
				};
			}
			throw error;
		}
		this.cursor = record.cursor;
		for (const { next } of committed) this.inputs.set(next.clientMessageId, next);
		// One notification per record: every input it changed, under its one cursor.
		this.publish(
			committed.map(({ next }) => next),
			record.cursor,
		);
		for (const { next, decision } of committed) {
			for (const effect of decision.effects) {
				if (effect.type === "dispatch") this.options.dispatch?.(effect.token, next);
				if (effect.type === "restore_to_draft") this.options.restoreToDraft?.(effect.text);
			}
		}
		return results;
	}

	private publish(inputs: readonly PendingInput[], cursor: number): void {
		const projections = inputs.map(projectPendingInput);
		for (const listener of this.listeners) {
			try {
				listener(projections, cursor);
			} catch (error) {
				this.reportListenerError(error);
			}
		}
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

export function isUncertainAppend(error: unknown): error is Error {
	return error instanceof Error && "code" in error && error.code === "pending_input_append_uncertain";
}

/** Replay or its durability fence failed; a later command can attempt recovery again. */
export class PendingInputStoreUnavailableError extends Error {
	readonly code = "pending_input_store_unavailable";
	constructor(cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			`Pending inputs could not be recovered from the local journal (${reason}); try again after fixing the file error.`,
			{ cause },
		);
		this.name = "PendingInputStoreUnavailableError";
	}
}

function sameHandle(left: PendingInputHandle, right: PendingInputHandle): boolean {
	return left.lifetimeId === right.lifetimeId && left.queuedId === right.queuedId;
}
