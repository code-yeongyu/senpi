import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "../../types.ts";
import type { AcpAvailableModel, AcpConfigOption } from "./acp-client.ts";

const ANSI_ESCAPE_SEQUENCE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const MODEL_LINE = /^([a-z0-9][a-z0-9.-]*)(?:\t+| {2,})(.+)$/;
const TIER_SUFFIX = /^(.+)-(low|medium|high|xhigh)$/;
const LABEL_TIER_SUFFIX = /\s*\((Low|Medium|High|XHigh)\)\s*$/i;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type AgyThinkingTier = "low" | "medium" | "high" | "xhigh";
export type AgyModelEntry = { id: string; label: string };

export const STATIC_AGY_MODELS: readonly AgyModelEntry[] = [
	{ id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)" },
	{ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
	{ id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
	{ id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
	{ id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" },
	{ id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)" },
	{ id: "gemini-4-carbon-low", label: "Gemini 4 Carbon (Low)" },
	{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
	{ id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
	{ id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
	{ id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)" },
	{ id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" },
	{ id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)" },
	{ id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)" },
	{ id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
	{ id: "gemini-pro-orchestrator", label: "Orchestrator (Carbon)" },
	{ id: "gemini-pro-orchestrator-argon", label: "Orchestrator (Argon)" },
	{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
	{ id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
	{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
	{ id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
	{ id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
	{ id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
	{ id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
	{ id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
	{ id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
	{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

let activeEntries: readonly AgyModelEntry[] = STATIC_AGY_MODELS;

export function rememberCatalogEntries(entries: readonly AgyModelEntry[]): void {
	if (entries.length > 0) activeEntries = [...entries];
}

export function currentCatalogEntries(): readonly AgyModelEntry[] {
	return activeEntries;
}

export function parseAgyModels(stdout: string): AgyModelEntry[] {
	const entries: AgyModelEntry[] = [];
	const seen = new Set<string>();
	for (const line of stdout.replace(ANSI_ESCAPE_SEQUENCE, "").split(/\r?\n/)) {
		const match = MODEL_LINE.exec(line.trim());
		if (!match) continue;
		const id = match[1]!;
		if (seen.has(id)) continue;
		seen.add(id);
		entries.push({ id, label: match[2]!.trim() });
	}
	return entries;
}

export function parseAgyAcpModels(
	availableModels: readonly AcpAvailableModel[] | undefined,
	configOptions: readonly AcpConfigOption[] | undefined,
): AgyModelEntry[] {
	const entries: AgyModelEntry[] = [];
	const seen = new Set<string>();
	if (availableModels !== undefined && availableModels.length > 0) {
		for (const item of availableModels) {
			if (!item.modelId || seen.has(item.modelId)) continue;
			seen.add(item.modelId);
			entries.push({ id: item.modelId, label: item.name?.trim() || item.modelId });
		}
		return entries;
	}
	const modelOption = configOptions?.find((opt) => opt.id === "model" || opt.category === "model");
	for (const choice of modelOption?.options ?? []) {
		if (!choice.value || seen.has(choice.value)) continue;
		seen.add(choice.value);
		entries.push({ id: choice.value, label: choice.name?.trim() || choice.value });
	}
	return entries;
}

export function extractConfigOptionValues(
	configOptions: readonly AcpConfigOption[] | undefined,
	optionId: string,
): { currentValue?: string; values: string[] } {
	const option = configOptions?.find((opt) => opt.id === optionId || opt.category === optionId);
	if (!option) return { values: [] };
	return {
		...(option.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
		values: (option.options ?? []).map((choice) => choice.value).filter(Boolean),
	};
}

function contextWindowFor(id: string): number {
	if (id.startsWith("gemini-")) return 1_048_576;
	if (/^claude-(?:opus|sonnet|fable)-5/.test(id)) return 1_000_000;
	return 200_000;
}

function maxTokensFor(id: string): number {
	if (id.startsWith("gemini-")) return 65_536;
	if (/^claude-(?:opus|sonnet|fable)-5/.test(id)) return 128_000;
	return 64_000;
}

function familyInfo(entries: readonly AgyModelEntry[]): Map<string, { label: string; tiers: Set<AgyThinkingTier> }> {
	const rawIds = new Set(entries.map((e) => e.id));
	const families = new Map<string, { label: string; tiers: Set<AgyThinkingTier> }>();
	for (const entry of entries) {
		const match = TIER_SUFFIX.exec(entry.id);
		if (!match) continue;
		const baseId = match[1]!;
		const tier = match[2] as AgyThinkingTier;
		if (rawIds.has(baseId)) continue;
		let family = families.get(baseId);
		if (!family) {
			const cleanLabel = entry.label.replace(LABEL_TIER_SUFFIX, "").trim() || baseId;
			family = { label: cleanLabel, tiers: new Set<AgyThinkingTier>() };
			families.set(baseId, family);
		}
		family.tiers.add(tier);
	}
	return families;
}

export function toProviderModels(entries: readonly AgyModelEntry[]): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = [];
	const families = familyInfo(entries);

	// Emit unified reasoning-aware family entries first (e.g. gemini-4-neon with low/medium/high/xhigh).
	for (const [baseId, family] of families) {
		if (family.tiers.size < 2) continue;
		models.push({
			id: baseId,
			name: `${family.label} via Antigravity`,
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: family.tiers.has("low") ? "low" : null,
				medium: family.tiers.has("medium") ? "medium" : null,
				high: family.tiers.has("high") ? "high" : null,
				xhigh: family.tiers.has("xhigh") ? "xhigh" : null,
				max: null,
			},
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: contextWindowFor(baseId),
			maxTokens: maxTokensFor(baseId),
		});
	}

	// Also emit every concrete agy model slug directly (e.g. gemini-4-neon-xhigh).
	for (const { id, label } of entries) {
		models.push({
			id,
			name: `${label} via Antigravity`,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: contextWindowFor(id),
			maxTokens: maxTokensFor(id),
		});
	}

	return models;
}

const PREFERENCE_BY_REASONING: Record<string, readonly AgyThinkingTier[]> = {
	max: ["xhigh", "high", "medium", "low"],
	xhigh: ["xhigh", "high", "medium", "low"],
	high: ["high", "xhigh", "medium", "low"],
	medium: ["medium", "high", "low", "xhigh"],
	low: ["low", "medium", "high", "xhigh"],
	minimal: ["low", "medium", "high", "xhigh"],
	off: ["low", "medium", "high", "xhigh"],
};

export type ResolveAgyModelTargetOptions = {
	readonly entries?: readonly AgyModelEntry[];
	readonly advertisedConfigModels?: readonly string[];
	readonly advertisedThoughtLevels?: readonly string[];
};

export type ResolvedAgyModelTarget = {
	readonly agyModelId: string;
	readonly thinkingTier?: AgyThinkingTier;
	readonly configModelId: string;
	readonly thoughtLevel?: AgyThinkingTier;
};

function isModelEntryList(
	value: readonly AgyModelEntry[] | ResolveAgyModelTargetOptions,
): value is readonly AgyModelEntry[] {
	return Array.isArray(value);
}

export function resolveAgyModelTarget(
	modelId: string,
	reasoning: ThinkingLevel | undefined,
	entriesOrOptions: readonly AgyModelEntry[] | ResolveAgyModelTargetOptions = activeEntries,
): ResolvedAgyModelTarget {
	const options: ResolveAgyModelTargetOptions = isModelEntryList(entriesOrOptions)
		? { entries: entriesOrOptions }
		: entriesOrOptions;
	const entries = options.entries ?? activeEntries;
	const catalog = entries.length > 0 ? entries : STATIC_AGY_MODELS;
	const advertisedModels = options.advertisedConfigModels;
	const advertisedTiers = options.advertisedThoughtLevels;

	const clampThoughtLevel = (
		preferredOrder: readonly AgyThinkingTier[],
		familyTiers?: ReadonlySet<AgyThinkingTier>,
	): AgyThinkingTier | undefined => {
		const validTiers =
			familyTiers && advertisedTiers && advertisedTiers.length > 0
				? preferredOrder.find((t) => familyTiers.has(t) && advertisedTiers.includes(t))
				: undefined;
		if (validTiers !== undefined) return validTiers;
		if (familyTiers) {
			const fromFamily = preferredOrder.find((t) => familyTiers.has(t));
			if (fromFamily !== undefined) return fromFamily;
		}
		if (advertisedTiers && advertisedTiers.length > 0) {
			return preferredOrder.find((t) => advertisedTiers.includes(t));
		}
		return preferredOrder[0];
	};

	const exact = catalog.find((e) => e.id === modelId);
	if (exact !== undefined) {
		const suffix = TIER_SUFFIX.exec(exact.id);
		if (suffix) {
			const baseId = suffix[1]!;
			const tier = suffix[2] as AgyThinkingTier;
			const families = familyInfo(catalog);
			const family = families.get(baseId);
			if (advertisedModels?.includes(baseId)) {
				const thoughtLevel = clampThoughtLevel(PREFERENCE_BY_REASONING[tier] ?? [tier], family?.tiers);
				return {
					agyModelId: exact.id,
					thinkingTier: tier,
					configModelId: baseId,
					...(thoughtLevel !== undefined ? { thoughtLevel } : {}),
				};
			}
			if (advertisedModels?.includes(exact.id)) {
				return {
					agyModelId: exact.id,
					thinkingTier: tier,
					configModelId: exact.id,
				};
			}
			// No advertised list yet: prefer base+thought if it's a multi-tier family, else concrete slug.
			if (family !== undefined && family.tiers.size >= 2) {
				return {
					agyModelId: exact.id,
					thinkingTier: tier,
					configModelId: baseId,
					thoughtLevel: tier,
				};
			}
			return {
				agyModelId: exact.id,
				thinkingTier: tier,
				configModelId: exact.id,
			};
		}
		return {
			agyModelId: exact.id,
			configModelId: exact.id,
		};
	}

	const families = familyInfo(catalog);
	const family = families.get(modelId);
	if (family !== undefined && family.tiers.size > 0) {
		const order = (reasoning !== undefined ? PREFERENCE_BY_REASONING[reasoning] : undefined) ?? [
			"xhigh",
			"high",
			"medium",
			"low",
		];
		const picked = clampThoughtLevel(order, family.tiers);
		const agyModelId = picked !== undefined ? `${modelId}-${picked}` : modelId;

		if (advertisedModels !== undefined) {
			if (advertisedModels.includes(modelId)) {
				return {
					agyModelId,
					...(picked !== undefined ? { thinkingTier: picked, thoughtLevel: picked } : {}),
					configModelId: modelId,
				};
			}
			if (picked !== undefined && advertisedModels.includes(`${modelId}-${picked}`)) {
				return {
					agyModelId,
					thinkingTier: picked,
					configModelId: `${modelId}-${picked}`,
				};
			}
		}

		return {
			agyModelId,
			...(picked !== undefined ? { thinkingTier: picked, thoughtLevel: picked } : {}),
			configModelId: modelId,
		};
	}

	return {
		agyModelId: modelId,
		configModelId: modelId,
	};
}

function parseCachedPayload(raw: string, now: number, ttlMs: number): AgyModelEntry[] | undefined {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("fetchedAt" in parsed) || !("entries" in parsed)) {
		return undefined;
	}
	const { fetchedAt, entries } = parsed as { fetchedAt: unknown; entries: unknown };
	if (
		typeof fetchedAt !== "number" ||
		!Number.isFinite(fetchedAt) ||
		now < fetchedAt ||
		now - fetchedAt >= ttlMs ||
		!Array.isArray(entries) ||
		!entries.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"id" in entry &&
				typeof entry.id === "string" &&
				"label" in entry &&
				typeof entry.label === "string",
		)
	) {
		return undefined;
	}
	return entries as AgyModelEntry[];
}

export function readCachedAgyModelsSync(path: string, now: number, ttlMs = DAY_MS): AgyModelEntry[] | undefined {
	try {
		return parseCachedPayload(readFileSync(path, "utf8"), now, ttlMs);
	} catch {
		return undefined;
	}
}

export async function readCachedAgyModels(
	path: string,
	now: number,
	ttlMs = DAY_MS,
): Promise<AgyModelEntry[] | undefined> {
	try {
		return parseCachedPayload(await readFile(path, "utf8"), now, ttlMs);
	} catch {
		return undefined;
	}
}

export async function writeCachedAgyModels(
	path: string,
	entries: readonly AgyModelEntry[],
	now: number,
): Promise<void> {
	await writeFile(path, JSON.stringify({ fetchedAt: now, entries }), "utf8");
}
