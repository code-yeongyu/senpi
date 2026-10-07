import type { ModelThinkingLevel, ThinkingLevelMap } from "../types.ts";
import aliasData from "./cursor-variant-aliases.json" with { type: "json" };
import {
	CURSOR_MODEL_CAPABILITIES,
	type CursorModelCapability,
	type CursorVariantAlias,
	getCursorVariantAlias,
	parseCursorVariantId,
} from "./model-capabilities.ts";

export { parseCursorVariantId } from "./model-capabilities.ts";

export interface CursorCatalogRawEntry {
	readonly id: string;
	readonly name: string;
	readonly input: readonly ("text" | "image")[];
	readonly cursorMaxMode: boolean;
}

export interface CursorCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly reasoning: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
	readonly window: number;
	readonly maxWindow?: number;
	readonly input: ("text" | "image")[];
	readonly cursorMaxMode: boolean;
	readonly capabilityId?: string;
	readonly thinkingMode?: boolean;
	readonly representativeVariantId?: string;
	readonly legacyAliases: readonly string[];
	/**
	 * Derived-group variant ids: normalized thinking level -> the exact server-listed
	 * variant id the live catalog serves. Present only on identities derived at
	 * runtime from ids the static alias table does not list (senpi#2038).
	 */
	readonly variantIds?: Readonly<Partial<Record<ModelThinkingLevel, string>>>;
}

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FALLBACK_WINDOW = 200000;
const STATIC_TARGETS = new Set(Object.values(aliasData.aliases).map((alias) => alias.targetId));

interface GroupMember {
	readonly raw: CursorCatalogRawEntry;
	readonly alias: CursorVariantAlias;
	readonly level: string | undefined;
	readonly thinking: boolean | undefined;
	readonly fast: boolean;
}

function isClaude(baseId: string): boolean {
	return baseId.startsWith("claude-");
}

function cleanName(members: readonly GroupMember[], baseId: string, thinkingMode: boolean | undefined): string {
	const levelWords = /(Minimal|Low|Medium|High|Extra High|XHigh|Max|None)/g;
	const representative =
		members.find((member) => member.level === "high") ??
		members.find((member) => member.level === "medium") ??
		members.find((member) => member.level === "low") ??
		members[0];
	let name = representative.raw.name;
	name = name.replace(/\s*\(NO ZDR\)\s*/g, " \u0001").trim();
	name = name.replace(new RegExp(`\\s+${levelWords.source}\\b`, "g"), "");
	name = name.replace(/\s+Fast\b/g, "");
	if (thinkingMode !== true) name = name.replace(/\s+Thinking\b/g, "");
	name = name
		.replace(/\u0001/g, "(NO ZDR)")
		.replace(/\s+/g, " ")
		.trim();
	if (name.length === 0) name = baseId;
	return name;
}

function buildLevelMap(
	members: readonly GroupMember[],
	capability: CursorModelCapability | undefined,
): ThinkingLevelMap {
	const observed = new Set(
		members.map((member) => member.level).filter((level): level is string => level !== undefined),
	);
	const map = {} as Record<ModelThinkingLevel, string | null>;
	for (const level of ALL_LEVELS) {
		if (level === "off") {
			const offSpec = capability?.levels.off;
			map.off = offSpec !== undefined && observed.has("none") ? offSpec.value : null;
			continue;
		}
		const spec = capability?.levels[level];
		map[level] = spec !== undefined && (observed.has(level) || observed.has(spec.value)) ? spec.value : null;
	}
	return map;
}

function pickRepresentative(members: readonly GroupMember[]): string {
	const withLevels = members.filter((member) => member.level !== undefined && member.level !== "none");
	const pool = withLevels.length > 0 ? withLevels : members;
	const order = ["medium", "low", "minimal", "high", "xhigh", "extra-high", "max", "none"];
	const sorted = [...pool].sort((a, b) => {
		const ai = order.indexOf(a.level ?? "none");
		const bi = order.indexOf(b.level ?? "none");
		if (ai !== bi) return ai - bi;
		return a.alias.legacyVariantId.localeCompare(b.alias.legacyVariantId);
	});
	return sorted[0].alias.legacyVariantId;
}

function normalizeDerivedLevel(token: string): ModelThinkingLevel | undefined {
	switch (token) {
		case "none":
			return "off";
		case "extra-high":
			return "xhigh";
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return token;
		default:
			return undefined;
	}
}

/**
 * Every level is explicit: an unobserved level maps to `null` (unsupported), because the
 * shared model contract treats an absent ordinary level as supported and would otherwise
 * offer levels the server never listed.
 */
function buildDerivedLevelMap(members: readonly GroupMember[]): ThinkingLevelMap {
	const map = Object.fromEntries(ALL_LEVELS.map((level) => [level, null])) as Record<
		ModelThinkingLevel,
		string | null
	>;
	for (const member of members) {
		const level = member.alias.level;
		if (level !== undefined && member.level !== undefined && map[level] === null) {
			map[level] = member.level;
		}
	}
	return map;
}

function buildDerivedVariantIds(
	members: readonly GroupMember[],
): Readonly<Partial<Record<ModelThinkingLevel, string>>> {
	const map: Partial<Record<ModelThinkingLevel, string>> = {};
	for (const member of members) {
		const level = member.alias.level;
		if (level !== undefined && map[level] === undefined) map[level] = member.raw.id;
	}
	return map;
}

/**
 * Derive variant-group aliases for raw ids the static alias table does not list.
 * A family (shared base id, with the `-thinking` infix as a separate identity for
 * Claude-style ids) is derived only when at least two distinct levels are observed
 * among its unlisted non-fast members in the same batch; `-fast` variants,
 * single-level families, and level-less ids stay flat exactly as today. Ids the
 * static table already covers are never re-derived, so static output stays
 * byte-identical (senpi#2038).
 */
export function deriveCursorVariantAliases(ids: readonly string[]): ReadonlyMap<string, CursorVariantAlias> {
	const families = new Map<
		string,
		{ targetId: string; levels: Set<ModelThinkingLevel>; members: [string, ModelThinkingLevel, string][] }
	>();
	const rawIds = new Set(ids);
	for (const id of ids) {
		if (getCursorVariantAlias(id) !== undefined) continue;
		const parsed = parseCursorVariantId(id);
		if (parsed.fast || parsed.level === undefined || parsed.baseId === "") continue;
		const level = normalizeDerivedLevel(parsed.level);
		if (level === undefined) continue;
		const targetId = parsed.thinking === true ? `${parsed.baseId}-thinking` : parsed.baseId;
		const family = families.get(targetId) ?? { targetId, levels: new Set(), members: [] };
		family.levels.add(level);
		family.members.push([id, level, parsed.level]);
		families.set(targetId, family);
	}
	const derived = new Map<string, CursorVariantAlias>();
	for (const family of families.values()) {
		// A derived target must not shadow a static identity, a static alias key, or a raw id.
		if (
			family.levels.size < 2 ||
			STATIC_TARGETS.has(family.targetId) ||
			getCursorVariantAlias(family.targetId) !== undefined ||
			rawIds.has(family.targetId)
		)
			continue;
		const chosen = new Map<ModelThinkingLevel, string>();
		for (const [id, level, suffix] of family.members) {
			const previous = chosen.get(level);
			if (previous === undefined) {
				chosen.set(level, id);
				continue;
			}
			const previousSuffix = parseCursorVariantId(previous).level;
			if (
				(suffix === level && previousSuffix !== level) ||
				((suffix === level) === (previousSuffix === level) && id < previous)
			) {
				chosen.set(level, id);
			}
		}
		for (const [level, id] of chosen) {
			derived.set(id, { targetId: family.targetId, legacyVariantId: id, encoding: "legacy-variant", level });
		}
	}
	return derived;
}

/** Normalize a raw Cursor catalog (live discovery, CLI scrape, or stored cache) into selectable identities. */
export function normalizeCursorCatalog(rawEntries: readonly CursorCatalogRawEntry[]): CursorCatalogEntry[] {
	const derived = deriveCursorVariantAliases(rawEntries.map((raw) => raw.id));
	const groups = new Map<string, GroupMember[]>();
	const order: string[] = [];
	for (const raw of rawEntries) {
		const alias = getCursorVariantAlias(raw.id) ?? derived.get(raw.id);
		if (!alias) {
			const parsed = parseCursorVariantId(raw.id);
			const key = `unknown${parsed.baseId}${raw.id}`;
			if (!groups.has(key)) order.push(key);
			const member: GroupMember = {
				raw,
				alias: { targetId: raw.id, legacyVariantId: raw.id, encoding: "legacy-variant" },
				level: parsed.level,
				thinking: parsed.thinking,
				fast: parsed.fast,
			};
			groups.set(key, [member]);
			continue;
		}
		const parsed = parseCursorVariantId(raw.id);
		const key = `${alias.targetId}${parsed.fast}`;
		if (!groups.has(key)) {
			order.push(key);
			groups.set(key, []);
		}
		(groups.get(key) as GroupMember[]).push({
			raw,
			alias,
			level: parsed.level,
			thinking: parsed.thinking,
			fast: parsed.fast,
		});
	}

	const out: CursorCatalogEntry[] = [];
	for (const key of order) {
		const members = groups.get(key) as GroupMember[];
		const first = members[0];
		const baseParsed = parseCursorVariantId(first.alias.targetId);
		const derivedGroup = members.every((member) => derived.has(member.raw.id));
		const baseId = derivedGroup ? parseCursorVariantId(first.raw.id).baseId : baseParsed.baseId;
		const capability = CURSOR_MODEL_CAPABILITIES[baseId];
		const isGrouped = members.length > 1 || first.alias.targetId !== first.raw.id;
		const efforts = members.filter((member) => member.level !== undefined && member.level !== "none");

		if (isGrouped && efforts.length > 0 && !first.fast) {
			const thinkingMode = isClaude(baseId) ? first.thinking === true : undefined;
			out.push({
				id: first.alias.targetId,
				name: cleanName(members, baseId, thinkingMode),
				reasoning: true,
				thinkingLevelMap: derivedGroup ? buildDerivedLevelMap(members) : buildLevelMap(members, capability),
				window: capability?.window ?? FALLBACK_WINDOW,
				...(capability?.maxWindow !== undefined ? { maxWindow: capability.maxWindow } : {}),
				input: [...new Set(members.flatMap((member) => member.raw.input))],
				cursorMaxMode: members.some((member) => member.raw.cursorMaxMode),
				capabilityId: baseId,
				...(thinkingMode !== undefined ? { thinkingMode } : {}),
				representativeVariantId: pickRepresentative(members),
				legacyAliases: members.map((member) => member.alias.legacyVariantId).sort(),
				...(derivedGroup ? { variantIds: buildDerivedVariantIds(members) } : {}),
			});
			continue;
		}

		for (const member of members) {
			const memberBase = parseCursorVariantId(member.raw.id).baseId;
			const memberCapability = CURSOR_MODEL_CAPABILITIES[memberBase];
			out.push({
				id: member.raw.id,
				name: member.raw.name,
				reasoning: false,
				window: memberCapability?.window ?? FALLBACK_WINDOW,
				...(memberCapability?.maxWindow !== undefined ? { maxWindow: memberCapability.maxWindow } : {}),
				input: [...member.raw.input],
				cursorMaxMode: member.raw.cursorMaxMode,
				legacyAliases: [member.alias.legacyVariantId],
			});
		}
	}
	return out;
}
