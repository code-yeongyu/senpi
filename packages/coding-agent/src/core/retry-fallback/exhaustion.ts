import type { FallbackReason } from "./controller-types.ts";

/** One chain rung that failed during a turn's fallback walk: the model it ran on and its provider error. */
export interface FallbackRungFailure {
	model: string;
	reason: FallbackReason;
	error: string;
}

/** Appends a rung failure unless it repeats the last one (one failure can be offered to the walk twice). */
export function recordRungFailure(failures: FallbackRungFailure[], failure: FallbackRungFailure): void {
	const last = failures.at(-1);
	if (last && last.model === failure.model && last.error === failure.error) return;
	failures.push(failure);
}

/**
 * The exhaustion text every surface shows: the failure that started the walk first, then each later rung
 * (senpi#4084). Without recorded rungs it falls back to the last error, as older events carried only that.
 */
export function describeFallbackExhaustion(event: {
	lastError: string;
	failures?: readonly FallbackRungFailure[];
}): string {
	const failures = event.failures ?? [];
	if (failures.length === 0) return event.lastError;
	return failures
		.map((failure, index) => `${index === 0 ? "" : "then "}${failure.model}: ${failure.error}`)
		.join("\n");
}
