import type { AgentMessage, QueuedInputPort } from "@earendil-works/pi-agent-core";
import type { PendingInputStore, PendingInputTransaction } from "./pending-input-store.ts";
import type { DeliveryToken } from "./pending-input-types.ts";

export interface SessionQueuedInputPortOptions {
	readonly store: PendingInputStore;
	readonly ownerId: string;
	readonly writerGeneration: number;
	readonly nextAttemptId: () => string;
	readonly clearGeneration?: () => number;
}

/** The agent's queue port, plus the copies a failed claim or release holds until the next claim (senpi#4045). */
export interface SessionQueuedInputPort extends QueuedInputPort {
	holdsRetained(message: AgentMessage): boolean;
	/** Edits a held copy in place, keeping its reservation, so the next claim delivers the edited text. */
	replaceRetained(message: AgentMessage, next: AgentMessage): boolean;
	removeRetained(message: AgentMessage): boolean;
}

/**
 * The session's side of the agent queues (senpi#3549). Every drain reserves the identified inputs it hands to a
 * turn, every consumption commits them, and every give-back releases them, each under the store's gate together
 * with the native buffer change. Input the store never admitted (no client id, or a legacy id) passes through.
 */
export function createSessionQueuedInputPort(options: SessionQueuedInputPortOptions): SessionQueuedInputPort {
	const attempts = new Map<AgentMessage, DeliveryToken>();
	const retained = new Map<
		"steering" | "followUp",
		{ readonly messages: AgentMessage[]; readonly restorable: () => boolean }
	>();

	const reserve = async (tx: PendingInputTransaction, message: AgentMessage): Promise<boolean> => {
		const clientMessageId = clientMessageIdOf(message);
		const input = clientMessageId === undefined ? undefined : tx.current(clientMessageId);
		if (clientMessageId === undefined || input === undefined) return true;
		const previous = attempts.get(message);
		if (input.phase === "sending" && previous !== undefined && input.attempt?.attemptId === previous.attemptId)
			return true;
		const token: DeliveryToken = {
			ownerId: options.ownerId,
			writerGeneration: options.writerGeneration,
			lifetimeId: input.handle.lifetimeId,
			attemptId: options.nextAttemptId(),
			clientMessageId,
		};
		attempts.set(message, token);
		await tx.apply(clientMessageId, { type: "reserve", token });
		if (tx.current(clientMessageId)?.attempt?.attemptId !== token.attemptId) {
			attempts.delete(message);
			return false;
		}
		return true;
	};

	// One journal record for the whole batch: a failed write leaves every input as it was, never half delivered.
	const settle = async (
		tx: PendingInputTransaction,
		messages: readonly AgentMessage[],
		type: "consumed" | "release",
	): Promise<DeliveryToken[]> => {
		const tokens = messages.flatMap((message) => {
			const token = attempts.get(message);
			return token === undefined ? [] : [token];
		});
		if (tokens.length === 0) return tokens;
		await tx.applyAll(tokens.map((token) => ({ clientMessageId: token.clientMessageId, event: { type, token } })));
		for (const message of messages) attempts.delete(message);
		return tokens;
	};

	// Consumption was never committed, so no consumer can hold these: removing them is fenced (senpi#3549).
	const cancelOf = (clientMessageId: string) => ({
		clientMessageId,
		event: { type: "cancel" as const, cause: "stop" as const, consumerFenced: true },
	});
	const cancelClaims = async (tx: PendingInputTransaction, messages: readonly AgentMessage[]): Promise<void> => {
		const ids = messages.flatMap((message) => {
			const token = attempts.get(message);
			attempts.delete(message);
			return token === undefined ? [] : [token.clientMessageId];
		});
		if (ids.length > 0) await tx.applyAll(ids.map(cancelOf));
	};
	const cancelReleased = async (tx: PendingInputTransaction, messages: readonly AgentMessage[]): Promise<void> => {
		const ids = messages.flatMap((message) => {
			const clientMessageId = clientMessageIdOf(message);
			return clientMessageId === undefined || tx.current(clientMessageId) === undefined ? [] : [clientMessageId];
		});
		if (ids.length > 0) await tx.applyAll(ids.map(cancelOf));
	};

	const retainedAt = (message: AgentMessage) => {
		for (const entry of retained.values()) {
			const index = entry.restorable() ? entry.messages.indexOf(message) : -1;
			if (index !== -1) return { messages: entry.messages, index };
		}
		return undefined;
	};

	return {
		claim: (queue, drain) =>
			options.store.transaction(async (tx) => {
				const pending = retained.get(queue);
				if (pending !== undefined && !pending.restorable()) {
					await cancelReleased(tx, pending.messages);
					for (const message of pending.messages) attempts.delete(message);
				}
				const generation = options.clearGeneration?.();
				const messages = [...(pending?.restorable() ? pending.messages : []), ...drain()];
				// In flight from here: an edit or removal must not reach a batch this claim is still reserving.
				retained.delete(queue);
				const claimed: AgentMessage[] = [];
				try {
					// A copy the store no longer authorizes (removed, delivered, failed) is stale and is not delivered.
					for (const message of messages) if (await reserve(tx, message)) claimed.push(message);
				} catch (error) {
					// A failed reservation has already drained the native queue. Keep its exact message objects
					// and tokens until a later claim recovers them; edits and removals apply here, and a clear still wins.
					retained.set(queue, { messages, restorable: () => options.clearGeneration?.() === generation });
					throw error;
				}
				return claimed;
			}),
		holdsRetained: (message) => retainedAt(message) !== undefined,
		replaceRetained: (message, next) => {
			const at = retainedAt(message);
			if (at === undefined) return false;
			at.messages[at.index] = next;
			const token = attempts.get(message);
			attempts.delete(message);
			if (token !== undefined) attempts.set(next, token);
			return true;
		},
		removeRetained: (message) => {
			const at = retainedAt(message);
			if (at === undefined) return false;
			at.messages.splice(at.index, 1);
			attempts.delete(message);
			return true;
		},
		commitConsumption: (_queue, messages) =>
			options.store.transaction(async (tx) => {
				await settle(tx, messages, "consumed");
			}),
		// Journal first: if the release cannot be recorded the input stays `sending` (uncertain on reopen) and is
		// not put back natively, so it can never be delivered twice. A clear that won keeps the messages out of the
		// queue and their records removed, in one record. Only a clear landing during the release's own append
		// needs the second, removing record.
		release: (queue, messages, giveBack) =>
			options.store
				.transaction(async (tx) => {
					if (!giveBack.restorable()) {
						await cancelClaims(tx, messages);
						return;
					}
					await settle(tx, messages, "release");
					if (!giveBack.restore()) await cancelReleased(tx, messages);
				})
				.catch((error: unknown) => {
					retained.set(queue, { messages, restorable: () => giveBack.restorable() });
					throw error;
				}),
	};
}

function clientMessageIdOf(message: AgentMessage): string | undefined {
	if (message.role !== "user" || !("clientMessageId" in message)) return undefined;
	return typeof message.clientMessageId === "string" ? message.clientMessageId : undefined;
}
