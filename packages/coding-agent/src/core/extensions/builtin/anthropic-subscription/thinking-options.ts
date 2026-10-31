import type { Api, Model, ThinkingBudgets, ThinkingLevel } from "@earendil-works/pi-ai";
import type { EffortLevel, Options, ThinkingConfig } from "./sdk-boundary.ts";

const ADAPTIVE_THINKING_MODEL_MARKERS = [
	"opus-4-6",
	"opus-4.6",
	"opus-4-7",
	"opus-4.7",
	"opus-4-8",
	"opus-4.8",
	"opus-5",
	"sonnet-4-6",
	"sonnet-4.6",
	"sonnet-5",
	"fable-5",
	"mythos-5",
] as const;

const NATIVE_XHIGH_EFFORT_MODEL_MARKERS = [
	"opus-4-7",
	"opus-4-8",
	"opus-5",
	"sonnet-5",
	"fable-5",
	"mythos-5",
] as const;

const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
	minimal: 2048,
	low: 8192,
	medium: 16384,
	high: 31999,
	max: 63999,
};

function includesModelMarker(model: Model<Api>, markers: readonly string[]): boolean {
	const id = model.id.toLowerCase();
	return markers.some((marker) => id.includes(marker));
}

function forcedAdaptiveThinking(model: Model<Api>): boolean | undefined {
	const compat = model.compat;
	if (!compat || !("forceAdaptiveThinking" in compat)) return undefined;
	return typeof compat.forceAdaptiveThinking === "boolean" ? compat.forceAdaptiveThinking : undefined;
}

function supportsAdaptiveThinking(model: Model<Api>): boolean {
	return forcedAdaptiveThinking(model) ?? includesModelMarker(model, ADAPTIVE_THINKING_MODEL_MARKERS);
}

function supportsNativeXhighEffort(model: Model<Api>): boolean {
	return includesModelMarker(model, NATIVE_XHIGH_EFFORT_MODEL_MARKERS);
}

function isEffortLevel(value: string): value is EffortLevel {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function mapThinkingLevelToEffort(model: Model<Api>, level: ThinkingLevel): EffortLevel {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string" && isEffortLevel(mapped)) return mapped;
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return supportsNativeXhighEffort(model) ? "xhigh" : "max";
		case "max":
			return "max";
	}
}

function mapThinkingTokens(reasoning: ThinkingLevel, thinkingBudgets: ThinkingBudgets | undefined): number {
	const budgetLevel = reasoning === "xhigh" ? "high" : reasoning;
	const customBudget = thinkingBudgets?.[budgetLevel];
	return typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0
		? customBudget
		: DEFAULT_THINKING_BUDGETS[budgetLevel];
}

/** The SDK reasoning options for a requested thinking level: adaptive effort on models that support it, a token budget otherwise. */
export function thinkingQueryOptions(
	model: Model<Api>,
	reasoning: ThinkingLevel | undefined,
	thinkingBudgets: ThinkingBudgets | undefined,
): Pick<Options, "thinking" | "effort" | "maxThinkingTokens"> {
	if (!reasoning) return {};
	if (supportsAdaptiveThinking(model)) {
		return {
			thinking: { type: "adaptive", display: "summarized" } satisfies ThinkingConfig,
			effort: mapThinkingLevelToEffort(model, reasoning),
		};
	}
	return { maxThinkingTokens: mapThinkingTokens(reasoning, thinkingBudgets) };
}
