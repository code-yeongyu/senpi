import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../../session-manager.ts";

export const PROMPT_CACHE_PREWARM_ENTRY_TYPE = "prompt-cache-prewarm";

export type PromptCachePrewarmEntryData =
	| { readonly phase: "warmed"; readonly provider: string; readonly model: string; readonly usage: Usage }
	| { readonly phase: "failed"; readonly provider: string; readonly model: string; readonly error: string }
	| { readonly phase: "skipped"; readonly provider: string; readonly model: string; readonly reason: string };

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): value is Usage {
	if (typeof value !== "object" || value === null) return false;
	const usage = value as Partial<Usage>;
	return (
		isFiniteNumber(usage.input) &&
		isFiniteNumber(usage.output) &&
		isFiniteNumber(usage.cacheRead) &&
		isFiniteNumber(usage.cacheWrite) &&
		typeof usage.cost === "object" &&
		usage.cost !== null &&
		isFiniteNumber(usage.cost.total)
	);
}

export function getPromptCachePrewarmUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "custom" || entry.customType !== PROMPT_CACHE_PREWARM_ENTRY_TYPE) return undefined;
	const data = entry.data as { phase?: unknown; usage?: unknown } | undefined;
	return data?.phase === "warmed" && isUsage(data.usage) ? data.usage : undefined;
}
