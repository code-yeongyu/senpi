/**
 * The foreground window is how long a bash tool call may block the model, which
 * is a different concern from `timeout` — the deadline that kills the process.
 * A command still running at the window is handed to a live background session
 * instead of being killed, so the turn is freed without losing the work.
 */

export const DEFAULT_FOREGROUND_WINDOW_SECONDS = 60;
/** A wait has nothing to show in the foreground; detach it almost at once. */
export const SLEEP_WAIT_WINDOW_SECONDS = 5;

export function resolveForegroundWindowSeconds(env: Record<string, string | undefined>): number {
	const parsed = Number.parseFloat(env.PI_BASH_FOREGROUND_SECONDS ?? "");
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FOREGROUND_WINDOW_SECONDS;
	return parsed;
}
