import { type ClientMessageIdentity, clientMessageIdentity } from "./client-message-identity.ts";

/** The provider hold that refuses a queued follow-up after an error run: a spent account or a held model family (senpi#3131). */
export interface QueuedInputHold {
	readonly provider: string;
	/** The user-facing refusal, naming the hold and its reset when the provider stated one. */
	readonly message: string;
	/** Epoch milliseconds the provider said the limit resets; absent when it named none. */
	readonly resetAt?: number;
}

/**
 * A queued follow-up that will not run: a run ended in a provider error under an account hold, so it was taken
 * out of the queue instead of being sent to the held provider (senpi#6868). A sender waiting on it resolves here.
 */
export type QueuedInputFailedEvent = ClientMessageIdentity & {
	readonly type: "queued_input_failed";
	readonly queuedId: string;
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly error: {
		readonly code: "account_usage_limit";
		readonly provider: string;
		readonly message: string;
		readonly resetAt?: number;
	};
};

/**
 * What happens to a follow-up still queued when a run ends on a provider error (senpi#6868). A person's abort, a blocked
 * retry and a required compaction keep it for the next prompt and never reach this decision. Otherwise the session is
 * idle and nothing else will drain the queue, so the follow-up starts its own turn, unless the provider is held: then it
 * fails typed, naming the hold, so a held account is never asked again by a queue (senpi#3131).
 */
export type QueuedInputAfterError =
	| { readonly kind: "start" }
	| { readonly kind: "fail"; readonly hold: QueuedInputHold };

export function queuedInputAfterError(hold: QueuedInputHold | undefined): QueuedInputAfterError {
	return hold === undefined ? { kind: "start" } : { kind: "fail", hold };
}

/** The failure record of each follow-up a hold took out of the queue, in queue order. */
export function queuedInputFailures(
	cleared: readonly (ClientMessageIdentity & {
		readonly queuedId: string;
		readonly text: string;
		readonly mode: "steer" | "followUp";
	})[],
	hold: QueuedInputHold,
): QueuedInputFailedEvent[] {
	return cleared.map((input) => ({
		type: "queued_input_failed",
		queuedId: input.queuedId,
		text: input.text,
		mode: input.mode,
		...clientMessageIdentity(input),
		error: {
			code: "account_usage_limit",
			provider: hold.provider,
			message: hold.message,
			...(hold.resetAt === undefined ? {} : { resetAt: hold.resetAt }),
		},
	}));
}
