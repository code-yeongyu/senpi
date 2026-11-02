import {
	SUMMARIZATION_MAX_DURATION_PER_TOKEN_MS,
	SUMMARIZATION_TOTAL_BUDGET_MS,
} from "../../../compaction/stream-watchdog.ts";
import type { OpenAiRemoteCompactionModel } from "./openai-remote-model.ts";

const OPENAI_REMOTE_COMPACTION_FLOOR_MS = 15_000;
/**
 * A live subscription-lane v2 compaction took 17.7 s at 16.7k context tokens (senpi#2378), so small
 * contexts keep a 90 s floor there.
 */
const CHATGPT_SUBSCRIPTION_REMOTE_COMPACTION_FLOOR_MS = 90_000;

/**
 * Budget for one remote compaction request, sized to the context it carries (senpi#2434).
 *
 * The request sends the whole conversation, so its latency grows with it: the subscription lane
 * measured ~1.06 ms/token and a 383k-token compaction took 257 s. Like the local summarizer's
 * budget (#1068) it grows by {@link SUMMARIZATION_MAX_DURATION_PER_TOKEN_MS} per token above a
 * per-lane floor, so a hung request on a small context is still abandoned quickly, and it is
 * clamped to {@link SUMMARIZATION_TOTAL_BUDGET_MS}. Every attempt of one compaction also shares
 * that bound (see {@link createRemoteCompactionDeadline}).
 */
export function openAiRemoteCompactionTimeoutMs(model: OpenAiRemoteCompactionModel, compactionTokens: number): number {
	const floorMs =
		model.api === "openai-codex-responses"
			? CHATGPT_SUBSCRIPTION_REMOTE_COMPACTION_FLOOR_MS
			: OPENAI_REMOTE_COMPACTION_FLOOR_MS;
	const scaledMs =
		Number.isFinite(compactionTokens) && compactionTokens > 0
			? compactionTokens * SUMMARIZATION_MAX_DURATION_PER_TOKEN_MS
			: 0;
	return Math.min(SUMMARIZATION_TOTAL_BUDGET_MS, Math.max(floorMs, scaledMs));
}

/** What the compaction does after a remote attempt runs out of its budget. */
export type RemoteCompactionTimeoutNextStep = "websocket" | "compact-endpoint" | "local-summary";

/**
 * One deadline for every remote attempt of a compaction: a lane that falls through v2, WebSocket
 * and the compact endpoint never holds the session longer than {@link SUMMARIZATION_TOTAL_BUDGET_MS}
 * in total before the local summary starts. Each attempt keeps its own size-scaled budget, clamped
 * to what is left.
 */
export function createRemoteCompactionDeadline(attemptBudgetMs: number, now: () => number = Date.now) {
	const deadlineMs = now() + Math.max(SUMMARIZATION_TOTAL_BUDGET_MS, attemptBudgetMs);
	const remainingMs = (): number => Math.max(0, deadlineMs - now());
	return {
		remainingMs,
		nextAttemptMs: (): number => Math.min(attemptBudgetMs, remainingMs()),
	};
}

export type RemoteCompactionTimeout = {
	/** Measured wait of the attempt that timed out. */
	waitedMs: number;
	tokens: number;
	next: RemoteCompactionTimeoutNextStep;
};

const NEXT_STEP_TEXT: Record<RemoteCompactionTimeoutNextStep, string> = {
	websocket: "retrying over the WebSocket route",
	"compact-endpoint": "retrying through the compact endpoint",
	"local-summary": "falling back to a local summary",
};

export function formatRemoteCompactionTimeoutNotice(timeout: RemoteCompactionTimeout): string {
	const seconds = Math.round(timeout.waitedMs / 1000);
	const tokens = Math.round(timeout.tokens).toLocaleString("en-US");
	return `Remote compaction timed out after ${seconds}s at ${tokens} tokens; ${NEXT_STEP_TEXT[timeout.next]}.`;
}

export async function runWithRemoteTimeout<T>(options: {
	signal: AbortSignal;
	timeoutMs: number;
	run: (signal: AbortSignal) => Promise<T>;
	onTimeout: (waitedMs: number) => void;
}): Promise<T | undefined> {
	if (options.signal.aborted) throw new Error("Request was aborted");
	const startedMs = Date.now();

	const controller = new AbortController();
	let timedOut = false;
	const abortFromSource = () => controller.abort();
	options.signal.addEventListener("abort", abortFromSource, { once: true });

	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			resolve("timeout");
		}, options.timeoutMs);
		timeout.unref?.();
	});

	const operation = options.run(controller.signal);
	try {
		const result = await Promise.race([operation, timeoutPromise]);
		if (result === "timeout") {
			options.onTimeout(Date.now() - startedMs);
			operation.catch(() => undefined);
			return undefined;
		}
		return result;
	} catch (error) {
		if (timedOut && !options.signal.aborted) {
			options.onTimeout(Date.now() - startedMs);
			return undefined;
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		options.signal.removeEventListener("abort", abortFromSource);
	}
}
