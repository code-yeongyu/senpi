/**
 * Cursor's server reports the real context ceiling for the live conversation
 * through `ConversationTokenDetails.maxTokens` on checkpoint frames. That
 * value belongs to the conversation, not the coding-agent session: a new
 * conversation opened under the same session must admit against the bootstrap
 * cap instead of inheriting the previous conversation's reported budget.
 *
 * Limits are therefore keyed by the session/conversation pair, with the
 * session kept as the teardown scope, and each session also tracks which
 * conversation is live (the last to report or be published). A report for a
 * different conversation switches the active one even when it reports an
 * explicit `0` (the bootstrap checkpoint), so the previous conversation's
 * value stops being returned; a checkpoint whose `tokenDetails` is absent
 * preserves whatever limit that conversation already had.
 *
 * Cursor can rotate a conversation's wire id without changing the base
 * conversation id the provider derives from `options.conversationId ??
 * options.sessionId`, and the admission side only knows that base identity
 * (this host's session id). The provider therefore publishes which wire
 * conversation the base identity currently resolves to
 * ({@link setCursorActiveConversationWire}); admission resolving the base
 * through the published wire reaches the limit recorded by the live wire's
 * checkpoint after a rotation, while the rotated wire contributes no limit
 * until its own checkpoint reports one.
 */

type CursorConversationLimit = {
	readonly sessionId: string;
	readonly conversationId: string;
	readonly maxTokens: number;
};

const limitsByConversation = new Map<string, CursorConversationLimit>();
const conversationsBySession = new Map<string, Set<string>>();
const activeConversationBySession = new Map<string, string>();
const wiresByBaseBySession = new Map<string, Map<string, string>>();

function limitKey(sessionId: string, conversationId: string): string {
	return `${sessionId}\u0000${conversationId}`;
}

/**
 * Publishes `wireConversationId` as the conversation Cursor currently runs for
 * `baseConversationId` under `sessionId`.
 *
 * The provider derives the wire id from the base id and can rotate it while
 * the base id - the identity admission names - stays put. Publishing the live
 * wire lets admission resolve that base identity to the conversation whose
 * checkpoint reports the limit, so a rotation cannot orphan the limit. The
 * wire keeps its own records, so the rotated wire contributes no limit until
 * its own checkpoint reports one.
 */
export function setCursorActiveConversationWire(
	sessionId: string | undefined,
	baseConversationId: string | undefined,
	wireConversationId: string | undefined,
): void {
	if (sessionId === undefined || baseConversationId === undefined || wireConversationId === undefined) return;
	let wires = wiresByBaseBySession.get(sessionId);
	if (wires === undefined) {
		wires = new Map();
		wiresByBaseBySession.set(sessionId, wires);
	}
	wires.set(baseConversationId, wireConversationId);
	activeConversationBySession.set(sessionId, wireConversationId);
}

/**
 * Records the limit a checkpoint reported for `conversationId` under
 * `sessionId`, or the absence of a limit when the checkpoint had none.
 *
 * Reporting makes `conversationId` the session's active conversation, so a
 * checkpoint for a different conversation - including the zero-valued
 * bootstrap checkpoint - never lets it inherit the previous conversation's
 * limit. The two non-positive cases mean different things: `undefined` is a
 * checkpoint that carried no token details at all (a partial patch), so an
 * existing limit stays in place, while an explicit non-positive report is the
 * server stating there is no ceiling to admit against, so the conversation's
 * recorded limit is dropped and admission falls back to the bootstrap byte
 * cap. Non-finite values are never recorded and preserve.
 */
export function recordCursorConversationContextLimit(
	sessionId: string | undefined,
	conversationId: string | undefined,
	maxTokens: number | undefined,
): void {
	if (sessionId === undefined || conversationId === undefined) return;
	let conversations = conversationsBySession.get(sessionId);
	if (conversations === undefined) {
		conversations = new Set();
		conversationsBySession.set(sessionId, conversations);
	}
	conversations.add(conversationId);
	activeConversationBySession.set(sessionId, conversationId);
	if (maxTokens === undefined || !Number.isFinite(maxTokens)) return;
	if (maxTokens <= 0) {
		limitsByConversation.delete(limitKey(sessionId, conversationId));
		return;
	}
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
 * provider derives the base conversation id). When the provider has published
 * the wire that base identity resolves to, the wire is authoritative: a
 * rotation keeps the live wire's recorded limit reachable. Otherwise the id
 * must name the active conversation, and a limit recorded for any other
 * conversation is never returned.
 */
export function getCursorConversationContextLimit(
	sessionId: string | undefined,
	conversationId?: string,
): number | undefined {
	if (sessionId === undefined) return undefined;
	if (conversationId !== undefined) {
		const publishedWireId = wiresByBaseBySession.get(sessionId)?.get(conversationId);
		if (publishedWireId !== undefined) {
			return limitsByConversation.get(limitKey(sessionId, publishedWireId))?.maxTokens;
		}
		const activeConversationId = activeConversationBySession.get(sessionId);
		if (activeConversationId === undefined || conversationId !== activeConversationId) return undefined;
		return limitsByConversation.get(limitKey(sessionId, activeConversationId))?.maxTokens;
	}
	const activeConversationId = activeConversationBySession.get(sessionId);
	if (activeConversationId === undefined) return undefined;
	return limitsByConversation.get(limitKey(sessionId, activeConversationId))?.maxTokens;
}

/** Drops every conversation's limit for a session, or every session when called without one. */
export function forgetCursorConversationContextLimit(sessionId?: string): void {
	if (sessionId === undefined) {
		limitsByConversation.clear();
		conversationsBySession.clear();
		activeConversationBySession.clear();
		wiresByBaseBySession.clear();
		return;
	}
	for (const conversationId of conversationsBySession.get(sessionId) ?? []) {
		limitsByConversation.delete(limitKey(sessionId, conversationId));
	}
	conversationsBySession.delete(sessionId);
	activeConversationBySession.delete(sessionId);
	wiresByBaseBySession.delete(sessionId);
}
