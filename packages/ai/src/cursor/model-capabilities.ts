import type { ModelThinkingLevel } from "../types.ts";
import { CURSOR_MODEL_CAPABILITIES } from "./capability-table.ts";
import aliasData from "./cursor-variant-aliases.json" with { type: "json" };

export type CursorCapabilityEvidence = "available-models" | "cli-live" | "suffix-only" | "served-checkpoint";
export type CursorLevelEncoding = "parameters" | "variant-id";
export type CursorParameterId = "thinking" | "context" | "effort" | "reasoning" | "reasoning_effort" | "fast";

export interface CursorLevelSpec {
	readonly value: string;
	readonly encoding: CursorLevelEncoding;
}

export interface CursorModelCapability {
	readonly catalogKey?: string;
	readonly evidence: CursorCapabilityEvidence;
	readonly window: number;
	readonly maxWindow?: number;
	readonly parameterOrder: readonly CursorParameterId[];
	readonly defaultContext?: string;
	/** Context token matching `window`; cursor truncates to whatever this asks for. */
	readonly requestContext?: string;
	readonly levels: Partial<Record<ModelThinkingLevel, CursorLevelSpec>>;
}

export { CURSOR_MODEL_CAPABILITIES } from "./capability-table.ts";

export interface CursorVariantAlias {
	readonly targetId: string;
	readonly level?: ModelThinkingLevel;
	readonly legacyVariantId: string;
	readonly encoding: "legacy-variant";
}

const ALIASES = aliasData.aliases as Record<string, CursorVariantAlias>;
const LEVEL_TOKENS = ["minimal", "low", "medium", "high", "extra-high", "xhigh", "max", "none"] as const;

export interface CursorVariantParse {
	readonly baseId: string;
	readonly level: string | undefined;
	readonly thinking: boolean | undefined;
	readonly fast: boolean;
	readonly originalId: string;
}

/** Lossless suffix parser: trailing `-fast`, `-thinking-<level>` or `-<level>-thinking`, bare `-thinking`, trailing level. */
export function parseCursorVariantId(originalId: string): CursorVariantParse {
	let rest = originalId;
	let fast = false;
	if (rest.endsWith("-fast")) {
		fast = true;
		rest = rest.slice(0, -5);
	}
	let level: string | undefined;
	let thinking: boolean | undefined;
	const alternation = LEVEL_TOKENS.join("|");
	const patterns: [RegExp, boolean][] = [
		[new RegExp(`-thinking-(${alternation})$`), true],
		[new RegExp(`-(${alternation})-thinking$`), true],
	];
	for (const [pattern, flag] of patterns) {
		const match = rest.match(pattern);
		if (match) {
			level = match[1];
			thinking = flag;
			rest = rest.slice(0, match.index);
			return { baseId: rest, level, thinking, fast, originalId };
		}
	}
	if (rest.endsWith("-thinking")) {
		return { baseId: rest.slice(0, -9), level, thinking: true, fast, originalId };
	}
	const levelMatch = rest.match(new RegExp(`-(${alternation})$`));
	if (levelMatch) {
		level = levelMatch[1];
		thinking = false;
		rest = rest.slice(0, levelMatch.index);
	}
	return { baseId: rest, level, thinking, fast, originalId };
}

export function getCursorVariantAlias(originalId: string): CursorVariantAlias | undefined {
	return ALIASES[originalId];
}

/** Resolve any known variant id to its selectable base identity; unknown ids return undefined. */
export function getCursorBaseIdForVariant(originalId: string): string | undefined {
	const alias = ALIASES[originalId];
	if (alias) {
		const parsed = parseCursorVariantId(alias.targetId);
		return parsed.baseId;
	}
	return undefined;
}

export function getCursorCapabilityForBase(baseId: string): CursorModelCapability | undefined {
	return CURSOR_MODEL_CAPABILITIES[baseId];
}
