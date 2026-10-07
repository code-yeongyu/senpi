/**
 * Detection for the error a retired extension context throws when used after
 * session replacement or reload (thrown by the extension runner; see
 * agent-session). Long-lived tickers retain a ctx across ticks, so they must
 * recognize this error and retire instead of spinning dead or escaping a timer
 * callback as an uncaught exception.
 *
 * The runner keeps the first retirement message it is given: a disposed session
 * (new/fork/switch replacement) retires with the prefix below, while
 * `AgentSession.reload()` retires the old generation with its own message.
 */
export const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";
export const STALE_EXTENSION_GENERATION_AFTER_RELOAD_MESSAGE = "stale extension generation after reload";

export function isStaleExtensionContextError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX) ||
			error.message === STALE_EXTENSION_GENERATION_AFTER_RELOAD_MESSAGE)
	);
}
