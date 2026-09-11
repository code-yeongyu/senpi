/**
 * Cursor's server reports the real context ceiling for the live conversation
 * through `ConversationTokenDetails.maxTokens` on checkpoint frames. That
 * value belongs to the conversation, not the coding-agent session: a new
 * conversation opened under the same session must admit against the bootstrap
 * cap instead of inheriting the previous conversation's reported budget.
 *
 * Limits are therefore keyed by the session/conversation pair, with the
 * session kept as the teardown scope, and each session also tracks which
 * conversation reported last. A report for a different conversation switches
 * the active one even when it carries no limit (the bootstrap checkpoint
 * reports `0`), so the previous conversation's value stops being returned.
 */

type CursorConversationLimit = {
	readonly sessionId: string;
	readonly conversationId: string;
	readonly maxTokens: number;
};

const limitsByConversation = new Map<string, CursorConversationLimit>();
const conversationsBySession = new Map<string, Set<string>>();
const activeConversationBySession = new Map<string, string>();

function limitKey(sessionId: string, conversationId: string): string {
	return `${sessionId}\u0000${conversationId}`;
}

/**
 * Records `maxTokens` for `conversationId` under `sessionId`.
 *
 * Reporting makes `conversationId` the session's active conversation, so a
 * checkpoint for a different conversation - including the zero-valued
 * bootstrap checkpoint - never lets it inherit the previous conversation's
 * limit. Non-positive or non-finite values are never recorded; for the
 * already active conversation they leave the existing limit in place, since a
 * later checkpoint may be a partial patch without token details.
 */
export function recordCursorConversationContextLimit(
	sessionId: string | undefined,
	conversationId: string | undefined,
	maxTokens: number,
): void {
	if (sessionId === undefined || conversationId === undefined) return;
	let conversations = conversationsBySession.get(sessionId);
	if (conversations === undefined) {
		conversations = new Set();
		conversationsBySession.set(sessionId, conversations);
	}
	conversations.add(conversationId);
	activeConversationBySession.set(sessionId, conversationId);
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) return;
	limitsByConversation.set(limitKey(sessionId, conversationId), {
		sessionId,
		conversationId,
		maxTokens: Math.floor(maxTokens),
	});
}

/**
 * Returns the reported limit for `conversationId`, or the active
 * conversation's limit when `conversationId` is omitted.
 *
 * Callers admitting a request must pass the conversation that request will
 * run on (`options.conversationId ?? options.sessionId`, mirroring how the
 * provider derives the base conversation id): a limit recorded for any other
 * conversation is never returned.
 */
export function getCursorConversationContextLimit(
	sessionId: string | undefined,
	conversationId?: string,
): number | undefined {
	if (sessionId === undefined) return undefined;
	const activeConversationId = activeConversationBySession.get(sessionId);
	if (activeConversationId === undefined) return undefined;
	if (conversationId !== undefined && conversationId !== activeConversationId) return undefined;
	return limitsByConversation.get(limitKey(sessionId, activeConversationId))?.maxTokens;
}

/** Drops every conversation's limit for a session, or every session when called without one. */
export function forgetCursorConversationContextLimit(sessionId?: string): void {
	if (sessionId === undefined) {
		limitsByConversation.clear();
		conversationsBySession.clear();
		activeConversationBySession.clear();
		return;
	}
	for (const conversationId of conversationsBySession.get(sessionId) ?? []) {
		limitsByConversation.delete(limitKey(sessionId, conversationId));
	}
	conversationsBySession.delete(sessionId);
	activeConversationBySession.delete(sessionId);
}
