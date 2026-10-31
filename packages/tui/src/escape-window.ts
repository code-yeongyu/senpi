/**
 * A pending lone ESC whose next input is delivered after the escape window is
 * released as a standalone Escape press before the new input is processed. The
 * decision uses the arrival-clock gap observed at delivery time, so an
 * over-window gap is always treated as a lone Escape regardless of whether the
 * flush timer callback ran first (#3628). Within the window the pair still
 * merges into one Alt-key sequence.
 */
export function isStaleEscape(pending: string, gapMs: number | undefined, escapeWindowMs: number): boolean {
	return pending === "\x1b" && gapMs !== undefined && gapMs >= escapeWindowMs;
}
