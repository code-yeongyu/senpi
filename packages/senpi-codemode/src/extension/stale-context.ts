/**
 * Detection for the error a retired host extension context throws once its session
 * was replaced (new/fork/switch) or reloaded. Mirrors the host's
 * `builtin/goal/stale-context.ts`, which stays internal to the host's builtins (the
 * `@code-yeongyu/senpi` package does not export it). Older hosts also predate the reload
 * message, so codemode carries both messages locally for compatibility.
 */
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";
const STALE_EXTENSION_GENERATION_AFTER_RELOAD_MESSAGE = "stale extension generation after reload";

export function isStaleExtensionContextError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX) ||
			error.message === STALE_EXTENSION_GENERATION_AFTER_RELOAD_MESSAGE)
	);
}
