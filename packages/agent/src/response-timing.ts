import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

/** The deltas that count as streamed output for time to first token and the generation window. */
export const STREAMED_DELTA_TYPES: ReadonlySet<string> = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

export type GenerationWindowMessage = {
	readonly usage?: { readonly reasoning?: number };
	readonly content?: ReadonlyArray<{ readonly type?: string }>;
};

/**
 * Whether a response generated output before its first streamed delta, so its generation window starts at the
 * response start instead (senpi#3393). Reasoning counted in usage.output may be hidden or only summarised after it
 * finished; a thinking block whose text never streamed (Bedrock, omitted display) reports no reasoning count. Shared
 * by the persisted timing (senpi#3879) and the TPS notice so both measure the same window.
 */
export function reasonedBeforeFirstDelta(message: GenerationWindowMessage, thinkingStreamed: boolean): boolean {
	if ((message.usage?.reasoning ?? 0) > 0) return true;
	if (thinkingStreamed) return false;
	return message.content?.some((block) => block.type === "thinking") ?? false;
}

/**
 * Records one response's timing as the agent loop streams it, then stamps it on the final message (senpi#3879).
 * Wall-clock fields use `Date.now()` so they line up with `timestamp`; the generation window uses the monotonic
 * clock, like the TPS notice, so a clock jump cannot make it negative.
 */
export function createResponseTimingRecorder() {
	let requestedAt: number | undefined;
	let startedMs: number | undefined;
	let firstDeltaMs: number | undefined;
	let lastDeltaMs: number | undefined;
	let firstTokenAt: number | undefined;
	let lastTokenAt: number | undefined;
	let thinkingStreamed = false;

	return {
		requested(): void {
			requestedAt = Date.now();
		},
		started(): void {
			startedMs ??= performance.now();
		},
		observe(event: AssistantMessageEvent): void {
			if (!STREAMED_DELTA_TYPES.has(event.type)) return;
			const now = performance.now();
			const at = Date.now();
			if (event.type === "thinking_delta") thinkingStreamed = true;
			firstDeltaMs ??= now;
			firstTokenAt ??= at;
			lastDeltaMs = now;
			lastTokenAt = at;
		},
		/** Stamps the final message. A response whose request was never issued gets no timing. */
		stamp(message: AssistantMessage): void {
			if (requestedAt === undefined) return;
			const windowStart = reasonedBeforeFirstDelta(message, thinkingStreamed) ? startedMs : firstDeltaMs;
			const generationMs =
				windowStart !== undefined && lastDeltaMs !== undefined && lastDeltaMs > windowStart
					? Math.round(lastDeltaMs - windowStart)
					: undefined;
			message.timing = {
				requestedAt,
				...(firstTokenAt === undefined ? {} : { firstTokenAt }),
				...(lastTokenAt === undefined ? {} : { lastTokenAt }),
				endedAt: Math.max(Date.now(), lastTokenAt ?? requestedAt),
				...(generationMs === undefined ? {} : { generationMs }),
			};
		},
	};
}
