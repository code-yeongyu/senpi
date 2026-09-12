/**
 * Detection for the error a retired extension context throws when used after
 * session replacement or reload (thrown by the extension runner; see
 * agent-session). Long-lived goal tickers retain a ctx across ticks, so they
 * must recognize this error and retire instead of spinning dead forever.
 */
export const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

export function isStaleExtensionContextError(error: unknown): error is Error {
	return error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX);
}
