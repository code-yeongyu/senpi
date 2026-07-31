import type { MonitorSnapshotEntry } from "./monitor-registry.ts";

export const MONITOR_STATUS_KEY = "monitors";

/** The footer shares one status line with other extensions; keep this brief. */
const MAX_STATUS_LENGTH = 48;
/** Marks the status as a live watch at a glance (same glyph family as the session selector). */
const WATCH_GLYPH = "◉";

function truncateEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Fits as many whole descriptions as possible into the budget, folding the rest
 * into a `+N more` counter so the monitor count is never truncated away.
 */
function packDescriptions(names: readonly string[], budget: number): string {
	for (let kept = names.length; kept >= 1; kept--) {
		const hiddenCount = names.length - kept;
		const tail = hiddenCount > 0 ? ` +${hiddenCount} more` : "";
		const joined = names.slice(0, kept).join(", ");
		if (joined.length + tail.length <= budget) return joined + tail;
	}
	const tail = names.length > 1 ? ` +${names.length - 1} more` : "";
	return truncateEnd(names[0] ?? "", Math.max(1, budget - tail.length)) + tail;
}

/**
 * Goal-style compact elapsed label (`5s`, `3m`, `2h 30m`, `1d 2h 3m`). Mirrors
 * `formatGoalElapsedSeconds` in the goal builtin; kept local so this builtin stays
 * self-contained, matching the existing monitor/eval status-file duplication.
 */
export function formatElapsedSeconds(value: number): string {
	const seconds = Math.max(0, Math.trunc(value));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.trunc(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.trunc(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours >= 24) {
		const days = Math.trunc(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours}h ${remainingMinutes}m`;
	}
	if (remainingMinutes === 0) return `${hours}h`;
	return `${hours}h ${remainingMinutes}m`;
}

/** Whole seconds since the oldest watch registered; never negative when the clock moves backwards. */
export function monitorElapsedSeconds(snapshot: readonly MonitorSnapshotEntry[], nowMs: number): number {
	let oldest = Number.POSITIVE_INFINITY;
	for (const entry of snapshot) oldest = Math.min(oldest, entry.startedAtMs);
	if (!Number.isFinite(oldest)) return 0;
	return Math.max(0, Math.round((nowMs - oldest) / 1000));
}

/** Brief footer text for the active monitors; undefined clears the status. */
export function formatMonitorStatus(snapshot: readonly MonitorSnapshotEntry[], nowMs: number): string | undefined {
	if (snapshot.length === 0) return undefined;
	const pausedCount = snapshot.filter((entry) => entry.paused).length;
	const pausedPart = pausedCount === 0 ? "" : pausedCount === snapshot.length ? ", paused" : `, ${pausedCount} paused`;
	const suffix = ` (${formatElapsedSeconds(monitorElapsedSeconds(snapshot, nowMs))}${pausedPart})`;
	if (snapshot.length === 1) {
		const head = `${WATCH_GLYPH} watching `;
		const description = truncateEnd(snapshot[0]?.description ?? "", MAX_STATUS_LENGTH - head.length - suffix.length);
		return head + description + suffix;
	}
	const head = `${WATCH_GLYPH} watching ${snapshot.length}: `;
	const names = snapshot.map((entry) => entry.description);
	return head + packDescriptions(names, MAX_STATUS_LENGTH - head.length - suffix.length) + suffix;
}
