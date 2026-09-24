import type { SessionEntry } from "../../../session-manager.ts";
import { GOAL_CACHE_WARMUP_ENTRY_TYPE, type GoalCacheWarmMetrics } from "./cache-warm.ts";

export interface ParkedGoalWait {
	readonly iteration: number;
	readonly delayMs: number;
	readonly dueAtMs: number;
	readonly cache?: GoalCacheWarmMetrics;
}

/**
 * Finds the wait a retired extension generation left parked for `goalId`, so a
 * reload re-arms that same wait instead of starting a new one. The branch tail
 * is authoritative: any message or custom message after the last cache-warm
 * entry means a turn ran since, so nothing is parked any more.
 */
export function findParkedGoalWait(entries: readonly SessionEntry[], goalId: string): ParkedGoalWait | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined) continue;
		if (entry.type === "message" || entry.type === "custom_message") return undefined;
		if (entry.type !== "custom" || entry.customType !== GOAL_CACHE_WARMUP_ENTRY_TYPE) continue;
		return parseParkedWait(entry.data, goalId);
	}
	return undefined;
}

function parseParkedWait(data: unknown, goalId: string): ParkedGoalWait | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const phase = Reflect.get(data, "phase");
	const entryGoalId = Reflect.get(data, "goalId");
	const iteration = Reflect.get(data, "iteration");
	const delayMs = Reflect.get(data, "delayMs");
	const dueAtMs = Reflect.get(data, "dueAtMs");
	if (phase !== "scheduled" || entryGoalId !== goalId) return undefined;
	if (typeof iteration !== "number" || !Number.isInteger(iteration) || iteration < 1) return undefined;
	if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0) return undefined;
	if (typeof dueAtMs !== "number" || !Number.isFinite(dueAtMs)) return undefined;
	const cache = parseCache(Reflect.get(data, "cache"));
	return { iteration, delayMs, dueAtMs, ...(cache !== undefined ? { cache } : {}) };
}

function parseCache(value: unknown): GoalCacheWarmMetrics | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const cachedTokens = Reflect.get(value, "cachedTokens");
	if (typeof cachedTokens !== "number" || !Number.isFinite(cachedTokens)) return undefined;
	const ttlSeconds = Reflect.get(value, "ttlSeconds");
	const estimatedSavedUsd = Reflect.get(value, "estimatedSavedUsd");
	return {
		cachedTokens,
		...(typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) ? { ttlSeconds } : {}),
		...(typeof estimatedSavedUsd === "number" && Number.isFinite(estimatedSavedUsd) ? { estimatedSavedUsd } : {}),
	};
}
