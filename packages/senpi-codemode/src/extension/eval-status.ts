import type { EvalDetachedCellStatusEntry } from "../tool/detached-cell-manager.ts";

export const EVAL_CELLS_STATUS_KEY = "eval-cells";

/** The footer shares one status line with other extensions; keep this brief. */
const MAX_STATUS_LENGTH = 48;
/** Same glyph the transcript uses for a detached cell, so the two surfaces read as one state. */
const DETACHED_GLYPH = "↗";

function truncateEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Fits as many whole labels as possible into the budget, folding the rest into
 * a `+N more` counter so the detached-cell count is never truncated away.
 */
function packLabels(labels: readonly string[], budget: number): string {
	for (let kept = labels.length; kept >= 1; kept--) {
		const hiddenCount = labels.length - kept;
		const tail = hiddenCount > 0 ? ` +${hiddenCount} more` : "";
		const joined = labels.slice(0, kept).join(", ");
		if (joined.length + tail.length <= budget) return joined + tail;
	}
	const tail = labels.length > 1 ? ` +${labels.length - 1} more` : "";
	return truncateEnd(labels[0] ?? "", Math.max(1, budget - tail.length)) + tail;
}

function labelOf(entry: EvalDetachedCellStatusEntry): string {
	return entry.title === undefined || entry.title.length === 0 ? entry.cellId : entry.title;
}

/**
 * Goal-style compact elapsed label (`5s`, `3m`, `2h 30m`, `1d 2h 3m`). Mirrors
 * the monitor builtin's formatElapsedSeconds; kept local like the rest of the
 * duplicated status-file helpers between the two packages.
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

/** Whole seconds since the oldest detached cell was created; never negative on clock skew. */
export function evalCellElapsedSeconds(entries: readonly EvalDetachedCellStatusEntry[], nowMs: number): number {
	let oldest = Number.POSITIVE_INFINITY;
	for (const entry of entries) oldest = Math.min(oldest, entry.startedAtMs);
	if (!Number.isFinite(oldest)) return 0;
	return Math.max(0, Math.round((nowMs - oldest) / 1000));
}

/** Brief footer text for the cells still running detached; undefined clears the status. */
export function formatEvalCellStatus(
	entries: readonly EvalDetachedCellStatusEntry[],
	nowMs: number,
): string | undefined {
	const first = entries[0];
	if (first === undefined) return undefined;
	const suffix = ` (${formatElapsedSeconds(evalCellElapsedSeconds(entries, nowMs))})`;
	if (entries.length === 1) {
		const head = `${DETACHED_GLYPH} ${first.language} · `;
		return head + truncateEnd(labelOf(first), MAX_STATUS_LENGTH - head.length - suffix.length) + suffix;
	}
	const head = `${DETACHED_GLYPH} eval ${entries.length}: `;
	return head + packLabels(entries.map(labelOf), MAX_STATUS_LENGTH - head.length - suffix.length) + suffix;
}
