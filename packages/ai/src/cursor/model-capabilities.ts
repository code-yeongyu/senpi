import type { ModelThinkingLevel } from "../types.ts";
import aliasData from "./cursor-variant-aliases.json" with { type: "json" };

export type CursorCapabilityEvidence = "available-models" | "cli-live" | "suffix-only";
export type CursorLevelEncoding = "parameters" | "variant-id";
export type CursorParameterId = "thinking" | "context" | "effort" | "reasoning" | "fast";

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

const P = "parameters" as const;
const V = "variant-id" as const;

function ladder(
	values: readonly string[],
	encoding: CursorLevelEncoding = P,
): Partial<Record<ModelThinkingLevel, CursorLevelSpec>> {
	const out: Partial<Record<ModelThinkingLevel, CursorLevelSpec>> = {};
	for (const value of values) out[value === "none" ? "off" : (value as ModelThinkingLevel)] = { value, encoding };
	return out;
}

const CLAUDE_ORDER: readonly CursorParameterId[] = ["thinking", "context", "effort"];
const GPT_ORDER: readonly CursorParameterId[] = ["context", "reasoning", "fast"];

function claude(
	window: number,
	maxWindow: number,
	levels: readonly string[],
	defaultContext: string,
): CursorModelCapability {
	return {
		evidence: "available-models",
		window,
		maxWindow,
		parameterOrder: CLAUDE_ORDER,
		defaultContext,
		requestContext: window >= 1_000_000 ? "1m" : defaultContext,
		levels: ladder(levels),
	};
}

function gpt(
	levels: readonly string[],
	order: readonly CursorParameterId[] = GPT_ORDER,
	window = 400000,
	maxWindow = 400000,
): CursorModelCapability {
	return {
		evidence: "available-models",
		window,
		maxWindow,
		parameterOrder: order,
		defaultContext: "272k",
		requestContext: order.includes("context") && window >= 1_000_000 ? "1m" : undefined,
		levels: ladder(levels),
	};
}

/**
 * Static cursor capability table. Values come from the live
 * aiserver.v1 AvailableModels capture of 2026-08-18 (evidence:
 * local-ignore/qa-evidence/20260818-cursor-reasoning-levels/available-models-catalog.json).
 * `GetUsableModels` carries no window or parameter field, so this table is the
 * authoritative source; see .omo/plans/cursor-reasoning-levels.md §3.1/§6.
 */
export const CURSOR_MODEL_CAPABILITIES: Record<string, CursorModelCapability> = {
	"claude-fable-5": claude(1000000, 1000000, ["low", "medium", "high", "xhigh", "max"], "300k"),
	"claude-sonnet-5": claude(1000000, 1000000, ["low", "medium", "high", "xhigh", "max"], "300k"),
	"claude-opus-4-7": claude(1000000, 1000000, ["low", "medium", "high", "xhigh", "max"], "300k"),
	"claude-opus-4-8": claude(1000000, 1000000, ["low", "medium", "high", "xhigh", "max"], "300k"),
	"claude-opus-5": claude(1000000, 1000000, ["low", "medium", "high", "xhigh", "max"], "300k"),
	"claude-4.6-opus": claude(1000000, 1000000, ["high", "max"], "200k"),
	"claude-4.6-sonnet": claude(1000000, 1000000, ["medium"], "200k"),
	"claude-4.5-opus": {
		evidence: "available-models",
		window: 200000,
		parameterOrder: ["thinking"],
		levels: { high: { value: "high", encoding: V } },
	},
	"gpt-5.6-sol": gpt(["none", "low", "medium", "high", "xhigh", "max"], GPT_ORDER, 1000000, 1000000),
	"gpt-5.6-luna": gpt(["none", "low", "medium", "high", "xhigh", "max"], GPT_ORDER, 1000000, 1000000),
	"gpt-5.6-terra": gpt(["none", "low", "medium", "high", "xhigh", "max"], GPT_ORDER, 272000, 272000),
	"gpt-5.5": {
		...gpt(["none", "low", "medium", "high"], GPT_ORDER, 1000000, 1000000),
		levels: { ...ladder(["none", "low", "medium", "high"]), xhigh: { value: "extra-high", encoding: P } },
	},
	"gpt-5.3-codex": {
		...gpt([], ["reasoning", "fast"]),
		maxWindow: undefined,
		defaultContext: undefined,
		levels: { ...ladder(["low", "medium", "high"]), xhigh: { value: "extra-high", encoding: P } },
	},
	"gpt-5.1": {
		...gpt([], ["reasoning"]),
		maxWindow: undefined,
		defaultContext: undefined,
		levels: ladder(["low", "high"]),
	},
	"gpt-5.2": {
		...gpt([], ["reasoning"]),
		maxWindow: undefined,
		defaultContext: undefined,
		levels: { ...ladder(["low", "high"]), xhigh: { value: "xhigh", encoding: V } },
	},
	"gpt-5.4": {
		...gpt([], ["reasoning"]),
		maxWindow: undefined,
		defaultContext: undefined,
		levels: { ...ladder(["low", "medium", "high"]), xhigh: { value: "xhigh", encoding: V } },
	},
	"gpt-5.4-mini": {
		evidence: "available-models",
		window: 400_000,
		parameterOrder: [],
		levels: ladder(["none", "low", "medium", "high", "xhigh"], V),
	},
	"gpt-5.4-nano": {
		...gpt([], ["reasoning"]),
		maxWindow: undefined,
		defaultContext: undefined,
		levels: ladder(["none", "low", "medium", "high", "xhigh"]),
	},
	"gemini-3.7-flash": {
		evidence: "cli-live",
		window: 1_048_576,
		parameterOrder: ["effort"],
		levels: ladder(["low", "medium", "high"]),
	},
	"gemini-3.6-flash": {
		evidence: "suffix-only",
		window: 1_048_576,
		parameterOrder: [],
		levels: ladder(["minimal", "low", "medium", "high"], V),
	},
	"cursor-grok-4.6": {
		evidence: "available-models",
		window: 500_000,
		parameterOrder: ["effort", "fast"],
		levels: ladder(["low", "medium", "high", "xhigh"]),
	},
	"cursor-grok-4.5": {
		evidence: "suffix-only",
		window: 500_000,
		parameterOrder: [],
		levels: ladder(["low", "medium", "high"], V),
	},
	"glm-5.2": {
		evidence: "available-models",
		window: 1000000,
		parameterOrder: ["reasoning"],
		levels: ladder(["high", "max"]),
	},
	"kimi-k3": {
		evidence: "available-models",
		window: 1048576,
		parameterOrder: ["reasoning"],
		levels: ladder(["low", "high", "max"]),
	},
	"composer-2.5": { evidence: "available-models", window: 200000, parameterOrder: ["fast"], levels: {} },
	"claude-haiku-4-5": { evidence: "available-models", window: 200000, parameterOrder: ["thinking"], levels: {} },
	"claude-4-sonnet": {
		evidence: "available-models",
		window: 200000,
		parameterOrder: ["thinking", "context"],
		defaultContext: "200k",
		levels: {},
	},
	"claude-4.5-sonnet": {
		evidence: "available-models",
		window: 200_000,
		parameterOrder: ["thinking", "context"],
		defaultContext: "200k",
		levels: {},
	},
	"kimi-k2.7-code": { evidence: "available-models", window: 262_144, parameterOrder: [], levels: {} },
	"gemini-3-flash": { evidence: "available-models", window: 1000000, parameterOrder: [], levels: {} },
	"gemini-3.1-pro": { evidence: "available-models", window: 1000000, parameterOrder: [], levels: {} },
	"gemini-3.5-flash": { evidence: "available-models", window: 1_048_576, parameterOrder: [], levels: {} },
	"gpt-5-mini": { evidence: "available-models", window: 400_000, parameterOrder: [], levels: {} },
};

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
