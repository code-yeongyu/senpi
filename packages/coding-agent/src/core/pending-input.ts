import { answer, reduceMutation } from "./pending-input-mutations.ts";
import type {
	DeliveryToken,
	PendingInput,
	PendingInputDecision,
	PendingInputEvent,
	PendingInputFailure,
	SubmitEvent,
} from "./pending-input-types.ts";

/** The one transition function of a pending input (senpi#3549); it never performs I/O. */
export function reducePendingInput(current: PendingInput | undefined, event: PendingInputEvent): PendingInputDecision {
	switch (event.type) {
		case "submit":
			return submit(current, event);
		case "edit":
		case "remove":
		case "retry":
			return reduceMutation(current, event);
		default:
			return current === undefined ? unchanged(undefined) : reduceLifecycle(current, event);
	}
}

function submit(current: PendingInput | undefined, event: SubmitEvent): PendingInputDecision {
	if (current !== undefined) {
		if (current.fingerprint !== event.fingerprint) {
			return { next: current, result: answer(current, "client_message_id_conflict"), effects: [] };
		}
		return {
			next: current,
			result: { ...answer(current, "replayed"), replayed: true, text: current.text },
			effects: [],
		};
	}
	const next: PendingInput = {
		clientMessageId: event.clientMessageId,
		fingerprint: event.fingerprint,
		handle: event.handle,
		revision: 1,
		hasEdits: false,
		text: event.text,
		attachments: event.attachments,
		requestedMode: event.requestedMode,
		phase: "queued",
		attemptCount: 0,
		superseded: [],
		operations: {},
	};
	return { next, result: answer(next, "admitted"), effects: [{ type: "persist" }] };
}

type LifecycleEvent = Exclude<PendingInputEvent, { readonly type: "submit" | "edit" | "remove" | "retry" }>;

function reduceLifecycle(current: PendingInput, event: LifecycleEvent): PendingInputDecision {
	switch (event.type) {
		case "reject_before_dispatch":
			return current.phase === "queued" ? persist(fail(current, "not_delivered", event.reason)) : unchanged(current);
		case "reserve": {
			if (current.phase !== "queued" || !tokenFitsInput(current, event.token)) return unchanged(current);
			const next: PendingInput = {
				...current,
				phase: "sending",
				attempt: event.token,
				attemptCount: current.attemptCount + 1,
			};
			return { next, effects: [{ type: "persist" }, { type: "dispatch", token: event.token }] };
		}
		case "consumed":
			return holdsAttempt(current, event.token) ? persist(deliver(current, "consumed")) : unchanged(current);
		case "handled":
			if (current.phase === "queued") return persist(deliver(current, "handled"));
			if (event.token !== undefined && holdsAttempt(current, event.token)) {
				return persist(deliver(current, "handled"));
			}
			return unchanged(current);
		case "refused":
			return holdsAttempt(current, event.token)
				? persist(fail(current, "not_delivered", event.reason))
				: unchanged(current);
		case "ambiguous":
			return holdsAttempt(current, event.token)
				? persist(fail(current, "uncertain", event.reason))
				: unchanged(current);
		case "owner_lost":
			return holdsAttempt(current, event.token)
				? persist(fail(current, "uncertain", "the delivering owner was lost"))
				: unchanged(current);
		case "witnessed":
			return current.phase === "failed" && current.failure?.delivery === "uncertain"
				? persist(deliver(current, "consumed"))
				: unchanged(current);
		case "non_delivery_proven":
			return current.phase === "failed" && current.failure?.delivery === "uncertain"
				? persist(fail(current, "not_delivered", current.failure.reason))
				: unchanged(current);
		case "teardown":
			return current.phase === "sending"
				? persist(fail(current, "uncertain", "torn down during handoff"))
				: unchanged(current);
		case "cancel":
			return cancel(current, event.cause, event.consumerFenced);
		case "rebind":
			return rebind(current, event.handle);
	}
}

function cancel(current: PendingInput, cause: "stop" | "child_cancel", consumerFenced: boolean): PendingInputDecision {
	const removable = current.phase === "queued" || (current.phase === "sending" && consumerFenced);
	if (!removable) {
		return current.phase === "sending"
			? persist(fail(current, "uncertain", "stopped before the handoff was confirmed"))
			: unchanged(current);
	}
	const next = settled({ ...current, phase: "removed", removedBy: cause });
	return {
		next,
		effects:
			cause === "stop"
				? [{ type: "persist" }, { type: "restore_to_draft", text: next.text }]
				: [{ type: "persist" }],
	};
}

function rebind(current: PendingInput, handle: PendingInput["handle"]): PendingInputDecision {
	if (current.phase === "delivered" || current.phase === "removed") return unchanged(current);
	const rebound: PendingInput = { ...current, handle, revision: 1 };
	return current.phase === "sending"
		? persist(fail(rebound, "uncertain", "the session reopened during handoff"))
		: persist(rebound);
}

function tokenFitsInput(input: PendingInput, token: DeliveryToken): boolean {
	return token.lifetimeId === input.handle.lifetimeId && token.clientMessageId === input.clientMessageId;
}

function holdsAttempt(input: PendingInput, token: DeliveryToken): boolean {
	const attempt = input.attempt;
	return (
		input.phase === "sending" &&
		attempt !== undefined &&
		attempt.attemptId === token.attemptId &&
		attempt.ownerId === token.ownerId &&
		attempt.writerGeneration === token.writerGeneration &&
		tokenFitsInput(input, token)
	);
}

function deliver(input: PendingInput, deliveredBy: PendingInput["deliveredBy"]): PendingInput {
	return settled({ ...input, phase: "delivered", ...(deliveredBy === undefined ? {} : { deliveredBy }) });
}

function fail(input: PendingInput, delivery: PendingInputFailure["delivery"], reason: string): PendingInput {
	const { attempt: _attempt, ...rest } = input;
	return { ...rest, phase: "failed", failure: { delivery, reason } };
}

function settled(input: PendingInput): PendingInput {
	const { attempt: _attempt, failure: _failure, ...rest } = input;
	return rest;
}

function persist(next: PendingInput): PendingInputDecision {
	return { next, effects: [{ type: "persist" }] };
}

function unchanged(current: PendingInput | undefined): PendingInputDecision {
	return { next: current, effects: [] };
}
