import { noticeEntryRenderer } from "../../notice/index.ts";
import type { EntryRenderer } from "../../types.ts";
import {
	formatCacheTtl,
	formatSavedUsd,
	formatWakeDuration,
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

function titleLine(data: GoalCacheWarmupEntryData): string {
	const wakeSources =
		data.activeMonitorCount === 1 ? "1 wake source on duty" : `${data.activeMonitorCount} wake sources on duty`;
	const iteration = validIteration(data.iteration);
	const iterationText = iteration === undefined ? "" : ` · iteration ${iteration}`;
	switch (data.phase) {
		case "scheduled":
			return `⚡ Cache-warm wait${iterationText} · ${wakeSources}`;
		case "resumed":
			return `⚡ Cache-warm wake${iterationText} · ${formatExpectedWake(data.dueAtMs, data.waitedMs ?? data.delayMs)} · ${wakeSources}`;
	}
}

function validIteration(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function whyLine(data: GoalCacheWarmupEntryData): string {
	switch (data.phase) {
		case "scheduled": {
			const expected = `Continuation expected ${formatExpectedWake(data.dueAtMs, data.delayMs)}`;
			if (data.cache?.ttlSeconds === undefined) {
				return `${expected} - the monitor wakes the goal the moment decisive output lands.`;
			}
			return data.delayMs < data.cache.ttlSeconds * 1000
				? `${expected} - the timed wake stays inside the ${formatCacheTtl(data.cache.ttlSeconds)} prompt-cache TTL.`
				: `${expected} - the prompt-cache TTL may elapse before the timed wake.`;
		}
		case "resumed":
			return "Woke on schedule to keep pursuing the goal.";
	}
}

function formatExpectedWake(dueAtMs: number | undefined, elapsedMs: number): string {
	if (dueAtMs === undefined || !Number.isFinite(dueAtMs)) return `waited ${formatWakeDuration(elapsedMs)}`;
	const timestamp = new Date(dueAtMs).toISOString().slice(0, 16).replace("T", " ");
	return `ready ${timestamp} UTC (${formatWakeDuration(elapsedMs)})`;
}

function expandedLine(data: GoalCacheWarmupEntryData): string {
	const planned = `goal ${data.goalId} · planned delay ${formatWakeDuration(data.delayMs)}`;
	if (data.phase === "scheduled") return `${planned} · ${formatExpectedWake(data.dueAtMs, data.delayMs)}`;
	return `${planned} · ${formatExpectedWake(data.dueAtMs, data.waitedMs ?? data.delayMs)}`;
}

function warmLine(data: GoalCacheWarmupEntryData): string | undefined {
	const cache = data.cache;
	if (cache === undefined || cache.cachedTokens <= 0) return undefined;
	const tokens = `~${formatWarmTokenCount(cache.cachedTokens)} tokens`;
	const ttlMayHaveElapsed =
		cache.ttlSeconds !== undefined && (data.waitedMs ?? data.delayMs) >= cache.ttlSeconds * 1000;
	if (ttlMayHaveElapsed) {
		return `${tokens} were cached after the prior turn · prompt-cache TTL may have elapsed before this wake`;
	}
	const body = data.phase === "scheduled" ? `${tokens} kept warm` : `${tokens} stayed warm in the prompt cache`;
	const saved =
		cache.estimatedSavedUsd !== undefined && cache.estimatedSavedUsd > 0
			? ` · est. ${formatSavedUsd(cache.estimatedSavedUsd)} saved vs a cold re-read`
			: "";
	return `${body}${saved}`;
}
