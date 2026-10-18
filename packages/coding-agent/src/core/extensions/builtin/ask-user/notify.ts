import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import type { AskUserVariant, QuestionRequest, QuestionResponse } from "./schema.ts";

export const ASK_USER_SETTLED_EVENT = "ask-user:settled";
export const ASK_USER_CLOSED_EVENT = "ask-user:closed";
export const ASK_USER_ASKED_EVENT = "ask-user:asked";
/** UI-only session metadata; never included in the model-facing answer frame. */
export const ASK_USER_QUESTION_ENTRY = "ask-user:question";
/** Durable terminal outcome, including silent cancellation, for restart recovery. */
export const ASK_USER_SETTLEMENT_ENTRY = "ask-user:settlement";
export interface AskUserQuestionEntry {
	readonly requestId: string;
	readonly headers: readonly string[];
}

export type AskUserAskedEvent = {
	readonly ctx: ExtensionContext;
	readonly request: QuestionRequest;
	readonly variant: AskUserVariant;
};

export type AskUserSettledEvent = {
	readonly ctx: ExtensionContext;
	readonly request: QuestionRequest;
	readonly response: QuestionResponse;
	readonly variant: AskUserVariant;
};

export type AskUserClosedEvent = {
	readonly requestId: string;
	readonly status: QuestionResponse["status"];
	readonly resolvedBy?: QuestionResponse["resolvedBy"];
};

/** Every terminal outcome, including cancellations that remain silent to settled listeners. */
export function emitAskUserClosed(
	pi: Pick<ExtensionAPI, "events">,
	requestId: string,
	response: Pick<QuestionResponse, "status" | "resolvedBy">,
): void {
	pi.events.emit(ASK_USER_CLOSED_EVENT, {
		requestId,
		status: response.status,
		...(response.resolvedBy !== undefined ? { resolvedBy: response.resolvedBy } : {}),
	} satisfies AskUserClosedEvent);
}

/** Publish only; the active hooks builtin owns preparation and command execution. */
export function emitAskUserNotification(
	pi: Pick<ExtensionAPI, "events">,
	ctx: ExtensionContext,
	request: QuestionRequest,
	response: QuestionResponse,
	variant: AskUserVariant,
): void {
	if (response.status === "cancelled") return;
	pi.events.emit(ASK_USER_SETTLED_EVENT, { ctx, request, response, variant } satisfies AskUserSettledEvent);
}
