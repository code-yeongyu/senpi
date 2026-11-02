import type { ModelThinkingLevel } from "../types.ts";
import type {
	CursorLevelEncoding,
	CursorLevelSpec,
	CursorModelCapability,
	CursorParameterId,
} from "./model-capabilities.ts";

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

const LEVELS_LOW_MAX = ["low", "medium", "high", "xhigh", "max"] as const;
const CONTEXT_TOKEN: Record<number, string> = { 300000: "300k", 256000: "256k" };

/** A family whose window is the default context option the server reported serving. */
function served(
	window: number,
	maxWindow: number | undefined,
	order: readonly CursorParameterId[],
	levels: readonly string[],
): CursorModelCapability {
	const context = order.includes("context") ? CONTEXT_TOKEN[window] : undefined;
	return {
		evidence: "served-checkpoint",
		window,
		...(maxWindow !== undefined ? { maxWindow } : {}),
		parameterOrder: order,
		...(context !== undefined ? { defaultContext: context, requestContext: context } : {}),
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
	// Families published after the 2026-08-18 capture (senpi#3620). Windows are the
	// ceilings the server reported on the first checkpoint on 2026-10-18 for the
	// suffix variant senpi sends (no context parameter, so Cursor's default option);
	// maxWindow is the largest context option AvailableModels offers.
	"claude-opus-5-5": served(300_000, 1_000_000, ["context", "effort", "fast"], LEVELS_LOW_MAX),
	"claude-fable-5-1": served(300_000, 1_000_000, ["thinking", "context", "effort"], LEVELS_LOW_MAX),
	"claude-sonnet-5-5": served(300_000, 1_000_000, ["context", "reasoning_effort"], LEVELS_LOW_MAX),
	"claude-haiku-5-5": served(300_000, 1_000_000, ["thinking", "context", "reasoning_effort"], LEVELS_LOW_MAX),
	"muse-wonder-1.0": served(300_000, 1_000_000, ["context", "reasoning_effort"], ["minimal", ...LEVELS_LOW_MAX]),
	"muse-spark-1.3": served(300_000, 1_000_000, ["context", "effort"], ["minimal", ...LEVELS_LOW_MAX]),
	"grok-4.7": served(256_000, 500_000, ["context", "reasoning_effort", "fast"], ["low", "medium", "high", "xhigh"]),
	"gemini-4-argon": served(200_000, undefined, ["reasoning_effort"], ["low", "medium", "high"]),
	"gemini-3.8-flash": served(200_000, undefined, ["reasoning_effort"], ["low", "medium", "high"]),
	default: served(256_000, undefined, [], []),
};
