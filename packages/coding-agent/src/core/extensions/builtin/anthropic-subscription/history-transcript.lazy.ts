/**
 * Lazy boundary for the seed-transcript builder (senpi#1977). `history-transcript.ts` reaches pi-ai's Anthropic Messages
 * conversion, which pi-ai itself keeps behind `api/anthropic-messages.lazy.ts`; a static edge here would load it on
 * every CLI start (about 20 ms measured after pi-ai is resident) although only a cold seed needs it. Callers await
 * this loader on their async path and use the module synchronously afterwards.
 */
import type * as HistoryTranscriptModule from "./history-transcript.ts";

export type HistoryTranscript = typeof HistoryTranscriptModule;

let loading: Promise<HistoryTranscript> | undefined;

/** Loads the module once; a failed load is not cached, so a later cold seed can retry. */
export function loadHistoryTranscript(): Promise<HistoryTranscript> {
	loading ??= import("./history-transcript.ts").catch((error: unknown) => {
		loading = undefined;
		throw error;
	});
	return loading;
}
