import { reducePendingInput } from "../../src/core/pending-input.ts";
import type {
	DeliveryToken,
	PendingInput,
	PendingInputEvent,
	PendingInputHandle,
	SubmitEvent,
} from "../../src/core/pending-input-types.ts";

export const CLIENT_ID = "c-1";
export const HANDLE: PendingInputHandle = { lifetimeId: "life-1", queuedId: "q_1" };
export const REOPENED: PendingInputHandle = { lifetimeId: "life-2", queuedId: "q_7" };

export const SUBMIT: SubmitEvent = {
	type: "submit",
	clientMessageId: CLIENT_ID,
	fingerprint: "fp-original",
	handle: HANDLE,
	text: "check the logs",
	attachments: [],
	requestedMode: "followUp",
};

export function token(attemptId = "a-1", overrides: Partial<DeliveryToken> = {}): DeliveryToken {
	return {
		ownerId: "owner-1",
		writerGeneration: 1,
		lifetimeId: HANDLE.lifetimeId,
		attemptId,
		clientMessageId: CLIENT_ID,
		...overrides,
	};
}

export function replay(...events: readonly PendingInputEvent[]): PendingInput {
	let current: PendingInput | undefined;
	for (const event of events) current = reducePendingInput(current, event).next;
	if (current === undefined) throw new Error("the events admitted no input");
	return current;
}

export const queued = (): PendingInput => replay(SUBMIT);
export const sending = (attemptId = "a-1"): PendingInput =>
	replay(SUBMIT, { type: "reserve", token: token(attemptId) });
export const uncertain = (): PendingInput =>
	replay(SUBMIT, { type: "reserve", token: token() }, { type: "ambiguous", token: token(), reason: "handoff lost" });
export const unsent = (): PendingInput =>
	replay(SUBMIT, { type: "reserve", token: token() }, { type: "refused", token: token(), reason: "target closed" });

export function edit(effectId: string, expectedRevision: number, text: string, handle = HANDLE): PendingInputEvent {
	return { type: "edit", effectId, handle, expectedRevision, text, attachments: [] };
}

export function remove(effectId: string, expectedRevision: number, handle = HANDLE): PendingInputEvent {
	return { type: "remove", effectId, handle, expectedRevision };
}
