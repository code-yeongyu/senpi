// Shape of one models.dev entry used to enrich an OpenGateway model. Each entry is
// validated on its own so one malformed third-party row drops only that model
// instead of failing (or corrupting) the whole catalog refresh. Dependency-free on
// purpose: generator tests run these scripts from an isolated package copy.

import type { ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";

interface CostRates {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}

export interface OpenGatewayEnrichmentSource {
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	limit?: { context?: number; output?: number };
	cost?: CostRates & { tiers?: (CostRates & { tier?: { type?: string; size?: number } })[] };
}

const EFFORT_VALUES = new Set<unknown>(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default", null]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown, check: (present: unknown) => boolean): boolean {
	return value === undefined || check(value);
}

const isString = (value: unknown) => typeof value === "string";
const isBoolean = (value: unknown) => typeof value === "boolean";
const isRate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isLimit = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;

function isRates(value: Record<string, unknown>): boolean {
	return ["input", "output", "cache_read", "cache_write"].every((key) => optional(value[key], isRate));
}

function isReasoningOption(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.type === "toggle") return true;
	if (value.type === "effort") return Array.isArray(value.values) && value.values.every((v) => EFFORT_VALUES.has(v));
	if (value.type === "budget_tokens") return optional(value.min, isRate) && optional(value.max, isRate);
	return false;
}

function isTier(value: unknown): boolean {
	if (!isRecord(value) || !isRates(value)) return false;
	return optional(
		value.tier,
		(tier) => isRecord(tier) && optional(tier.type, isString) && optional(tier.size, isLimit),
	);
}

function isEnrichmentSource(value: unknown): value is OpenGatewayEnrichmentSource {
	if (!isRecord(value)) return false;
	const { name, tool_call, reasoning, reasoning_options, limit, cost } = value;
	return (
		optional(name, isString) &&
		optional(tool_call, isBoolean) &&
		optional(reasoning, isBoolean) &&
		optional(reasoning_options, (options) => Array.isArray(options) && options.every(isReasoningOption)) &&
		optional(limit, (l) => isRecord(l) && optional(l.context, isLimit) && optional(l.output, isLimit)) &&
		optional(
			cost,
			(c) => isRecord(c) && isRates(c) && optional(c.tiers, (tiers) => Array.isArray(tiers) && tiers.every(isTier)),
		)
	);
}

export function asEnrichmentSource(value: unknown): OpenGatewayEnrichmentSource | undefined {
	return isEnrichmentSource(value) ? value : undefined;
}
