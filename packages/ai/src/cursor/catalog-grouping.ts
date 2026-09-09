import type { ModelThinkingLevel, ThinkingLevelMap } from "../types.ts";
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
}

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FALLBACK_WINDOW = 200000;

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

/** Normalize a raw Cursor catalog (live discovery, CLI scrape, or stored cache) into selectable identities. */
export function normalizeCursorCatalog(rawEntries: readonly CursorCatalogRawEntry[]): CursorCatalogEntry[] {
	const groups = new Map<string, GroupMember[]>();
	const order: string[] = [];
	for (const raw of rawEntries) {
		const alias = getCursorVariantAlias(raw.id);
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
		const baseId = baseParsed.baseId;
		const capability = CURSOR_MODEL_CAPABILITIES[baseId];
		const isGrouped = members.length > 1 || first.alias.targetId !== first.raw.id;
		const efforts = members.filter((member) => member.level !== undefined && member.level !== "none");

		if (isGrouped && efforts.length > 0 && !first.fast) {
			const thinkingMode = isClaude(baseId) ? first.thinking === true : undefined;
			out.push({
				id: first.alias.targetId,
				name: cleanName(members, baseId, thinkingMode),
				reasoning: true,
				thinkingLevelMap: buildLevelMap(members, capability),
				window: capability?.window ?? FALLBACK_WINDOW,
				...(capability?.maxWindow !== undefined ? { maxWindow: capability.maxWindow } : {}),
				input: [...new Set(members.flatMap((member) => member.raw.input))],
				cursorMaxMode: members.some((member) => member.raw.cursorMaxMode),
				capabilityId: baseId,
				...(thinkingMode !== undefined ? { thinkingMode } : {}),
				representativeVariantId: pickRepresentative(members),
				legacyAliases: members.map((member) => member.alias.legacyVariantId).sort(),
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
