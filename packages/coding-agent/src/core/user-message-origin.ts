import type { UserMessage } from "@earendil-works/pi-ai";

/** `details.origin` reserved for later answers the built-in ask-user extension delivers (senpi#3888, senpi#3936). */
export const ASK_USER_ANSWER_ORIGIN = "ask-user-answer";

/**
 * Harness-issued permission to stamp the ask-user answer marker. The extension loader issues it only for the
 * built-in ask-user extension's own `sendUserMessage` calls; extension code has no way to pass one.
 */
export interface UserMessageOriginGrant {
	readonly askUserAnswerRequestId: string;
}

export function askUserAnswerOriginGrant(details: UserMessage["details"]): UserMessageOriginGrant | undefined {
	if (details?.origin !== ASK_USER_ANSWER_ORIGIN || typeof details.requestId !== "string") return undefined;
	return { askUserAnswerRequestId: details.requestId };
}

/**
 * Details persisted on an extension-delivered user message. A caller-supplied reserved origin is always
 * dropped and only a harness grant sets it, so the marker proves the built-in ask-user path delivered the
 * message rather than any extension that copied its shape.
 */
export function persistedUserMessageDetails(
	details: UserMessage["details"],
	grant: UserMessageOriginGrant | undefined,
): UserMessage["details"] {
	let kept = details;
	if (details?.origin === ASK_USER_ANSWER_ORIGIN) {
		const { origin: _reserved, ...rest } = details;
		kept = Object.keys(rest).length === 0 ? undefined : rest;
	}
	if (grant === undefined) return kept;
	return { ...kept, origin: ASK_USER_ANSWER_ORIGIN, requestId: grant.askUserAnswerRequestId };
}
