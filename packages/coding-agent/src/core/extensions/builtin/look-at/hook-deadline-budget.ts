import { toolResultHandlerTimeoutMs } from "../../tool-hook-wait.ts";

/** The path the host keys this builtin's `tool_result` deadline on (`resource-loader.ts`). */
const LOOK_AT_EXTENSION_PATH = "<builtin:look-at>";

/** The part of the host's deadline the descriptions may use; the rest is left for returning their result. */
const DEADLINE_SHARE = 0.9;

export interface HookDeadlineBudget {
	signal: AbortSignal | undefined;
	dispose(): void;
}

/**
 * At its `tool_result` deadline the host stops waiting on the handler but aborts nothing the handler started,
 * so a description request would keep running detached and its result would be dropped. The requests of one
 * handler run share this budget instead: it starts with the handler, ends before the host's deadline and
 * aborts them at its end, as well as with the turn.
 */
export function startHookDeadlineBudget(turnSignal: AbortSignal | undefined): HookDeadlineBudget {
	const deadlineMs = toolResultHandlerTimeoutMs(LOOK_AT_EXTENSION_PATH);
	if (deadlineMs <= 0) return { signal: turnSignal, dispose: () => {} };

	const controller = new AbortController();
	const abort = () => controller.abort(turnSignal?.reason);
	if (turnSignal?.aborted) abort();
	else turnSignal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(), deadlineMs * DEADLINE_SHARE);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			turnSignal?.removeEventListener("abort", abort);
		},
	};
}
