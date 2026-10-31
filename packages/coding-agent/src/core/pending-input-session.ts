import { createHash, randomUUID } from "node:crypto";
import type { QueuedInputPort } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionPendingInputJournal } from "./pending-input-journal.ts";
import type { PendingInputProjection } from "./pending-input-projection.ts";
import { createSessionQueuedInputPort } from "./pending-input-session-port.ts";
import { PENDING_INPUT_TRANSITION, type PendingInputJournal, PendingInputStore } from "./pending-input-store.ts";
import type { OperationOutcome, PendingInputMode, PendingInputOperationResult } from "./pending-input-types.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionManager } from "./session-manager.ts";

export interface IdentifiedInput {
	readonly clientMessageId: string;
	readonly text: string;
	readonly images?: readonly ImageContent[];
	readonly mode: PendingInputMode;
}

export interface SessionPendingInputsOptions {
	readonly sessionManager: ConstructorParameters<typeof SessionPendingInputJournal>[0] &
		Pick<SessionManager, "reduceHistory">;
	/** The session's own queue-id counter, so a store handle and the session's queued record share one id. */
	readonly nextQueuedId: () => string;
	/** Receives every committed change, in cursor order. */
	readonly onChange?: (update: PendingInputUpdate) => void;
	/** Defaults to the session JSONL; injectable so tests can fail an append. */
	readonly journal?: PendingInputJournal;
}

export interface PendingInputUpdate {
	readonly lifetimeId: string;
	readonly cursor: number;
	readonly changes: readonly PendingInputProjection[];
}

/** Every input that still needs an outcome, plus an explicit answer for each id the caller already knows. */
export interface PendingInputSnapshot {
	readonly lifetimeId: string;
	readonly throughCursor: number;
	readonly inputs: readonly PendingInputProjection[];
	readonly outcomes: readonly (
		| { readonly clientMessageId: string; readonly status: "admitted"; readonly projection: PendingInputProjection }
		| { readonly clientMessageId: string; readonly status: "not_admitted" }
	)[];
}

/** The legacy answers of `dequeue_message` / `edit_queued_message`. */
export type QueuedInputChangeOutcome = "removed" | "edited" | "already_delivered" | "not_found" | "conflict";

export interface QueuedInputChangeRequest {
	readonly clientMessageId: string;
	/** Undefined removes the input; a string replaces its text. */
	readonly text: string | undefined;
	readonly expectedRevision?: number;
	readonly effectId?: string;
}

export class ClientMessageIdConflictError extends Error {
	readonly code = "client_message_id_conflict";
	readonly clientMessageId: string;
	constructor(clientMessageId: string) {
		super(`Client message id ${clientMessageId} was already used for a different message.`);
		this.name = "ClientMessageIdConflictError";
		this.clientMessageId = clientMessageId;
	}
}

/** Whether the session history records any pending-input transition; folded without a full-history view (senpi#2537). */
const holdsPendingInputTransition: HistoryReducer<boolean> = {
	initial: () => false,
	add: (held, entry) => held || (entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION),
};

/**
 * The pending inputs of one AgentSession (senpi#3549): the store, opened on the first identified input, and the
 * agent queue port over it. Input without a client id never touches the store and keeps the legacy queue path.
 */
export class SessionPendingInputs {
	readonly lifetimeId = randomUUID();
	private readonly options: SessionPendingInputsOptions;
	private storeOpening: Promise<PendingInputStore> | undefined;
	private port: QueuedInputPort | undefined;
	private attempts = 0;
	/** Bumped synchronously by every clear, so a change can tell a clear it raced from a real divergence. */
	private clears = 0;

	constructor(options: SessionPendingInputsOptions) {
		this.options = options;
		// A session file that already holds pending inputs is recovered now: the agent's first drain must see them.
		const journaled = options.sessionManager.reduceHistory(holdsPendingInputTransition);
		// Opened eagerly, unawaited: every later use awaits this same opening and surfaces its failure, so the
		// eager start only must not report it a second time as an unhandled rejection.
		if (journaled) this.store().catch(() => undefined);
	}

	/**
	 * How a restored input (from the RPC admission ledger after a reopen) re-enters the native queue: under the
	 * store's rebound queue id while it is still queued; not at all once the store retired it (delivered, removed,
	 * failed); `undefined` when the store never held it, so the caller restores it as before.
	 */
	async restoreHandle(clientMessageId: string): Promise<{ readonly queuedId: string } | "retired" | undefined> {
		if (this.storeOpening === undefined) return undefined;
		const input = (await this.storeOpening).current(clientMessageId);
		if (input === undefined) return undefined;
		return input.phase === "queued" ? { queuedId: input.handle.queuedId } : "retired";
	}

	/**
	 * Admits an identified input and, only when it is newly admitted, puts its native copy in the agent queue
	 * inside the same gated step, so no drain, edit or removal can run between the two. A repeated submit of the
	 * same input is answered from the record (`replayed`) and enqueues nothing.
	 */
	async admit(
		input: IdentifiedInput,
		enqueue: (queuedId: string) => void,
	): Promise<PendingInputOperationResult | undefined> {
		const store = await this.store();
		return store.transaction(async (tx) => {
			const result = await tx.submit({
				clientMessageId: input.clientMessageId,
				fingerprint: admissionFingerprint(input),
				text: input.text,
				attachments: (input.images ?? []).map(attachmentFingerprint),
				requestedMode: input.mode,
			});
			if (result?.outcome === "client_message_id_conflict")
				throw new ClientMessageIdConflictError(input.clientMessageId);
			const admitted = tx.current(input.clientMessageId);
			if (result?.outcome === "admitted" && admitted !== undefined) enqueue(admitted.handle.queuedId);
			return result;
		});
	}

	/**
	 * Edits or removes an identified input: the store transition is journaled first, and only when it answers
	 * `edited`/`removed` does `applyNative` change the native queue, inside the same gated step, so no drain
	 * can see one without the other. Returns undefined when the store never admitted this input.
	 */
	async change(
		request: QueuedInputChangeRequest,
		applyNative: () => QueuedInputChangeOutcome,
	): Promise<QueuedInputChangeOutcome | undefined> {
		if (this.storeOpening === undefined) return undefined;
		const clearsAtStart = this.clears;
		const store = await this.storeOpening;
		return store.transaction(async (tx) => {
			const current = tx.current(request.clientMessageId);
			if (current === undefined) return undefined;
			const target = {
				effectId: request.effectId ?? randomUUID(),
				handle: current.handle,
				expectedRevision: request.expectedRevision ?? current.revision,
			};
			const result =
				request.text === undefined
					? await tx.apply(request.clientMessageId, { type: "remove", ...target })
					: await tx.apply(request.clientMessageId, {
							type: "edit",
							...target,
							text: request.text,
							attachments: current.attachments,
						});
			const outcome = legacyOutcome(result?.outcome);
			if (outcome !== "edited" && outcome !== "removed") return outcome;
			const native = applyNative();
			// A synchronous clear can empty the queue while the change is being journaled; its own record of the
			// clear is queued behind this step and retires the input, so the change simply found nothing. Any other
			// missing native copy is a real divergence (review L1, L-c).
			if (native === "not_found" && this.clears !== clearsAtStart) return "not_found";
			if (native !== outcome) throw new PendingInputDivergenceError(request.clientMessageId, outcome, native);
			return outcome;
		});
	}

	/**
	 * Records an explicit clear (Stop, `clear_queue`, unload with clearQueue) of identified inputs that just left the
	 * native queue: each still-queued one is removed by `stop`, so a reopen never queues it again.
	 */
	async recordCleared(clientMessageIds: readonly string[]): Promise<void> {
		this.clears += 1;
		if (this.storeOpening === undefined || clientMessageIds.length === 0) return;
		const store = await this.storeOpening;
		// One record for the whole clear: it lands or not as a unit, never split around a later entry.
		await store.transaction(async (tx) => {
			const queued = clientMessageIds.filter((clientMessageId) => tx.current(clientMessageId)?.phase === "queued");
			if (queued.length === 0) return;
			await tx.applyAll(
				queued.map((clientMessageId) => ({
					clientMessageId,
					event: { type: "cancel", cause: "stop", consumerFenced: true },
				})),
			);
		});
	}

	/**
	 * Pending inputs (queued, sending, failed) and the outcome of each known id, consistent through
	 * `throughCursor`: apply it, then only updates with a later cursor. Absence from `inputs` is never an outcome.
	 */
	async snapshot(knownClientMessageIds: readonly string[] = []): Promise<PendingInputSnapshot> {
		const store = this.storeOpening === undefined ? undefined : await this.storeOpening;
		const inputs = (store?.snapshot() ?? []).filter(
			(input) => input.state !== "delivered" && input.state !== "removed",
		);
		const outcomes = knownClientMessageIds.map((clientMessageId) => {
			const read = store?.read(clientMessageId);
			return read?.status === "admitted"
				? { clientMessageId, status: "admitted" as const, projection: read.projection }
				: { clientMessageId, status: "not_admitted" as const };
		});
		return { lifetimeId: this.lifetimeId, throughCursor: store?.throughCursor ?? 0, inputs, outcomes };
	}

	/** The agent's queue port. Before the store opens nothing identified is queued, so it drains natively. */
	queuedInputPort(): QueuedInputPort {
		return {
			claim: async (queue, drain) => (await this.openPort())?.claim(queue, drain) ?? drain(),
			commitConsumption: async (queue, messages) => (await this.openPort())?.commitConsumption(queue, messages),
			release: async (queue, messages, giveBack) => {
				const port = await this.openPort();
				if (port === undefined) giveBack.restore();
				else await port.release(queue, messages, giveBack);
			},
		};
	}

	private store(): Promise<PendingInputStore> {
		this.storeOpening ??= PendingInputStore.open({
			journal: this.options.journal ?? new SessionPendingInputJournal(this.options.sessionManager),
			lifetimeId: this.lifetimeId,
			nextQueuedId: this.options.nextQueuedId,
			// The agent port commits consumption before any provider sees an input, so an attempt left `sending` by a
			// crash was never sent and returns to the queue under its id (T28).
			uncommittedAttemptsAreUnsent: true,
		}).then((store) => {
			const onChange = this.options.onChange;
			if (onChange !== undefined)
				store.subscribe((projections, cursor) =>
					onChange({ lifetimeId: this.lifetimeId, cursor, changes: projections }),
				);
			return store;
		});
		return this.storeOpening;
	}

	private async openPort(): Promise<QueuedInputPort | undefined> {
		if (this.storeOpening === undefined) return undefined;
		const store = await this.storeOpening;
		this.port ??= createSessionQueuedInputPort({
			store,
			ownerId: `${process.pid}:${this.lifetimeId}`,
			writerGeneration: 1,
			nextAttemptId: () => `${this.lifetimeId}:${++this.attempts}`,
		});
		return this.port;
	}
}

function admissionFingerprint(input: IdentifiedInput): string {
	const images = (input.images ?? []).map(attachmentFingerprint);
	return sha256(JSON.stringify([input.mode, input.text, images]));
}

function attachmentFingerprint(image: ImageContent): string {
	return `${image.mimeType}:${sha256(image.data)}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** The store changed an input that the native queue no longer held: the two views disagree and must not be hidden. */
export class PendingInputDivergenceError extends Error {
	readonly code = "pending_input_divergence";
	constructor(clientMessageId: string, recorded: string, native: string) {
		super(`Queued input ${clientMessageId} was ${recorded} in its record but ${native} in the queue.`);
		this.name = "PendingInputDivergenceError";
	}
}

/** `sending` keeps the legacy spelling `already_delivered` (the handoff began); the snapshot says `sending`. */
function legacyOutcome(outcome: OperationOutcome | undefined): QueuedInputChangeOutcome {
	switch (outcome) {
		case "edited":
		case "removed":
		case "conflict":
		case "already_delivered":
			return outcome;
		case "sending":
			return "already_delivered";
		default:
			return "not_found";
	}
}
