import type { ModelThinkingLevel, ThinkingLevelMap } from "./types.ts";

/**
 * Reasoning levels an OpenAI-compatible endpoint advertises for one model through the
 * `reasoning_efforts` field of its `/models` listing (senpi#2196).
 */
export interface EndpointReasoningEfforts {
	/**
	 * senpi level -> the endpoint's own spelling, sent on the wire as-is. Every level the endpoint
	 * did not advertise is `null`, so the map is authoritative and no level is inferred from the id.
	 * Absent when the endpoint advertised a ladder but no value in it names a senpi level: the model's
	 * reasoning controls cannot be represented, which is different from advertising nothing at all.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Level of the entry the endpoint marks `default: true`, when that entry maps. */
	defaultThinkingLevel?: ModelThinkingLevel;
	/** Advertised values that name no senpi level; reported, never sent. */
	unmapped: string[];
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// A Map, not an object literal: an advertised "__proto__" or "constructor" must not resolve.
const LEVEL_BY_NAME: ReadonlyMap<string, ModelThinkingLevel> = new Map([
	["none", "off"],
	["off", "off"],
	["minimal", "minimal"],
	["low", "low"],
	["medium", "medium"],
	["high", "high"],
	["xhigh", "xhigh"],
	["max", "max"],
]);

function readEntry(entry: unknown): { value: string; isDefault: boolean } | undefined {
	if (typeof entry === "string") return entry.trim() ? { value: entry, isDefault: false } : undefined;
	if (typeof entry !== "object" || entry === null || !("value" in entry)) return undefined;
	const { value } = entry;
	const isDefault = "default" in entry && entry.default === true;
	return typeof value === "string" && value.trim() ? { value, isDefault } : undefined;
}

/**
 * Map a `reasoning_efforts` listing (`[{ "value": "low" }, { "value": "high", "default": true }]`,
 * or plain strings) onto senpi's levels. Matching is case-insensitive; the first spelling of a
 * level wins. Returns undefined only when nothing was advertised (the value is not an array); an
 * advertised ladder with no representable value yields no map.
 */
export function parseEndpointReasoningEfforts(value: unknown): EndpointReasoningEfforts | undefined {
	if (!Array.isArray(value)) return undefined;
	const advertised = new Map<ModelThinkingLevel, string>();
	const unmapped: string[] = [];
	let defaultThinkingLevel: ModelThinkingLevel | undefined;
	for (const raw of value) {
		const entry = readEntry(raw);
		if (!entry) continue;
		const level = LEVEL_BY_NAME.get(entry.value.trim().toLowerCase());
		if (!level) {
			if (!unmapped.includes(entry.value)) unmapped.push(entry.value);
			continue;
		}
		if (!advertised.has(level)) advertised.set(level, entry.value);
		if (entry.isDefault && defaultThinkingLevel === undefined) defaultThinkingLevel = level;
	}
	if (advertised.size === 0) return { unmapped };
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = advertised.get(level) ?? null;
	return defaultThinkingLevel === undefined
		? { thinkingLevelMap, unmapped }
		: { thinkingLevelMap, defaultThinkingLevel, unmapped };
}
