import type { CustomEntry } from "../../../session-manager.ts";
import { noticeEntryRenderer } from "../../notice/index.ts";
import type { EntryRenderer } from "../../types.ts";
import {
	formatCacheTtl,
	formatSavedUsd,
	formatWakeDuration,
	formatWakeTimestamp,
	formatWarmTokenCount,
	type GoalCacheWarmupEntryData,
} from "./cache-warm.ts";

export const renderGoalCacheWarmupEntry: EntryRenderer<GoalCacheWarmupEntryData> = noticeEntryRenderer((entry) => {
	const data = entry.data;
	if (data === undefined) return undefined;
	const warm = warmLine(data);
	return {
		title: titleLine(data),
		why: whyLine(data),
		extra: warm === undefined ? [] : [{ text: warm, tone: "success" }],
		expandedLine: expandedLine(data),
	};
});

/**
 * One card per wait cycle: a cache-warm entry for the same Goal that directly follows the
 * previous card (a reload re-arm, or the wake that ends the wait) replaces it in place.
 */
export function isSameGoalCacheWarmCard(
	previous: CustomEntry<GoalCacheWarmupEntryData>,
	next: CustomEntry<GoalCacheWarmupEntryData>,
): boolean {
	const goalId = next.data?.goalId;
	return typeof goalId === "string" && goalId.length > 0 && previous.data?.goalId === goalId;
}

function titleLine(data: GoalCacheWarmupEntryData): string {
	const wakeSources =
		data.activeMonitorCount === 1 ? "1 wake source on duty" : `${data.activeMonitorCount} wake sources on duty`;
	const iteration = validIteration(data.iteration);
	const iterationText = iteration === undefined ? "" : ` · iteration ${iteration}`;
	switch (data.phase) {
		case "scheduled":
			return `⚡ Cache-warm wait${iterationText} · ${wakeSources}`;
		case "resumed":
			return `⚡ Cache-warm wake${iterationText} · waited ${formatWakeDuration(data.waitedMs ?? data.delayMs)} · ${wakeSources}`;
	}
}

function validIteration(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function whyLine(data: GoalCacheWarmupEntryData): string {
	switch (data.phase) {
		case "scheduled": {
			// The wait is not a cache-warm timer: it lets the live wake sources
			// deliver, and the timed wake is only the stall backstop.
			const backstop = `Stall backstop ${formatExpectedWake(data.dueAtMs, data.delayMs)}`;
			if (data.cache?.ttlSeconds === undefined) {
				return `${backstop} - the goal resumes as soon as a wake source delivers.`;
			}
			return data.delayMs < data.cache.ttlSeconds * 1000
				? `${backstop} - the goal resumes as soon as a wake source delivers, inside the ${formatCacheTtl(data.cache.ttlSeconds)} prompt-cache TTL.`
				: `${backstop} - the goal resumes as soon as a wake source delivers; the ${formatCacheTtl(data.cache.ttlSeconds)} prompt-cache TTL may elapse first.`;
		}
		case "resumed":
			switch (data.wakeCause) {
				case "timer":
					return "The stall backstop fired; queued the goal continuation.";
				case "sources-drained":
					return "Wake sources finished; queued the goal continuation.";
				case undefined:
					return "Queued the goal continuation; the wake trigger was not recorded.";
			}
	}
}

function formatExpectedWake(dueAtMs: number | undefined, elapsedMs: number): string {
	if (dueAtMs === undefined || !Number.isFinite(dueAtMs)) return `waited ${formatWakeDuration(elapsedMs)}`;
	return `ready ${formatWakeTimestamp(dueAtMs)} (${formatWakeDuration(elapsedMs)})`;
}

function expandedLine(data: GoalCacheWarmupEntryData): string {
	const planned = `goal ${data.goalId} · planned delay ${formatWakeDuration(data.delayMs)}`;
	if (data.phase === "scheduled") return `${planned} · ${formatExpectedWake(data.dueAtMs, data.delayMs)}`;
	return `${planned} · ${formatExpectedWake(data.dueAtMs, data.waitedMs ?? data.delayMs)}`;
}

function warmLine(data: GoalCacheWarmupEntryData): string | undefined {
	const cache = data.cache;
	if (cache === undefined || cache.cachedTokens <= 0) return undefined;
	const body = `Prior turn: ~${formatWarmTokenCount(cache.cachedTokens)} cache-read/write tokens (cumulative)`;
	if (cache.cacheLifetime === "best-effort") {
		return `${body} · provider caching is best-effort; next cache hit unverified`;
	}
	const ttlMayHaveElapsed =
		cache.ttlSeconds !== undefined && (data.waitedMs ?? data.delayMs) >= cache.ttlSeconds * 1000;
	if (ttlMayHaveElapsed) {
		return `${body} · prompt-cache TTL may have elapsed; next cache hit unverified`;
	}
	const saved =
		cache.estimatedSavedUsd !== undefined && cache.estimatedSavedUsd > 0
			? ` · est. ${formatSavedUsd(cache.estimatedSavedUsd)} discount if reused`
			: "";
	return `${body}${saved} · next cache hit unverified`;
}
