/**
 * How long the host waits on one tool hook handler (oh-my-openagent#14354).
 *
 * A `tool_call` / `tool_result` handler runs in-process. One that never settles used to hold the tool loop forever:
 * the await had no deadline and ignored the turn's abort signal, so neither Esc nor an RPC interrupt ended it. The
 * wait now ends when the handler settles, when the turn is aborted, or (for `tool_result`) at a deadline. A handler
 * the host stopped waiting on keeps running detached; whatever it later returns or throws is discarded.
 */

/** The builtin hooks extension runs user command hooks under their own configured timeout, so it gets no host deadline. */
const SELF_BOUNDED_TOOL_HOOK_PATH = "<builtin:hooks>";

/** Default deadline for one `tool_result` handler of an extension that does not bound itself. */
const DEFAULT_TOOL_RESULT_HANDLER_TIMEOUT_MS = 120_000;

const TOOL_RESULT_HANDLER_TIMEOUT_ENV = "SENPI_TOOL_RESULT_HANDLER_TIMEOUT_MS";

/** The `tool_result` deadline for an extension: 0 (none) for a self-bounded one, else the env override or the default. */
export function toolResultHandlerTimeoutMs(
	extensionPath: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	if (extensionPath === SELF_BOUNDED_TOOL_HOOK_PATH) return 0;
	const raw = env[TOOL_RESULT_HANDLER_TIMEOUT_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_TOOL_RESULT_HANDLER_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TOOL_RESULT_HANDLER_TIMEOUT_MS;
}

export type ToolHookWaitOutcome<T> =
	| { readonly kind: "settled"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "timed_out"; readonly elapsedMs: number }
	| { readonly kind: "aborted" };

export interface ToolHookWait<T> {
	readonly run: () => Promise<T> | T;
	/** The turn's abort signal: its abort ends the wait at once. */
	readonly signal?: AbortSignal;
	/** 0 waits without a deadline. */
	readonly timeoutMs: number;
	readonly now?: () => number;
}

/** Waits on one handler until it settles, the signal aborts or the deadline passes, whichever comes first. */
export async function waitForToolHook<T>(wait: ToolHookWait<T>): Promise<ToolHookWaitOutcome<T>> {
	const now = wait.now ?? Date.now;
	const startedAt = now();
	if (wait.signal?.aborted) return { kind: "aborted" };
	let started: Promise<T>;
	try {
		started = Promise.resolve(wait.run());
	} catch (error) {
		started = Promise.reject(error);
	}
	// Captured before the race, so a rejection after the host stopped waiting is already handled.
	const settled = started.then(
		(value): ToolHookWaitOutcome<T> => ({ kind: "settled", value }),
		(error: unknown): ToolHookWaitOutcome<T> => ({ kind: "failed", error }),
	);
	if (wait.signal === undefined && wait.timeoutMs <= 0) return settled;
	return new Promise<ToolHookWaitOutcome<T>>((resolve) => {
		const timer =
			wait.timeoutMs > 0
				? setTimeout(() => finish({ kind: "timed_out", elapsedMs: now() - startedAt }), wait.timeoutMs)
				: undefined;
		const onAbort = (): void => finish({ kind: "aborted" });
		function finish(outcome: ToolHookWaitOutcome<T>): void {
			clearTimeout(timer);
			wait.signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		}
		wait.signal?.addEventListener("abort", onAbort, { once: true });
		void settled.then(finish);
	});
}
