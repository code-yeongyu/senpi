/**
 * Carries a value from a session to the session that replaces it (senpi#4051).
 *
 * `newSession()` retires the old extension generation before the replacement starts, so a captured `pi` cannot emit
 * after the switch, and emitting before it would report a switch that `session_before_switch` may still cancel. The
 * builtin factory outlives both generations in one process, so the value waits here, keyed by the session being
 * replaced, until the replacement's `session_start` takes it through its own live `pi`. The holder releases its key
 * once `newSession()` settles, so a cancelled or failed switch delivers nothing.
 */
export interface ReplacementRelay<T> {
	hold(previousSessionFile: string | undefined, value: T): void;
	take(previousSessionFile: string | undefined): T | undefined;
	release(previousSessionFile: string | undefined): void;
}

export function createReplacementRelay<T>(): ReplacementRelay<T> {
	const pending = new Map<string | undefined, T>();
	return {
		hold: (previousSessionFile, value) => {
			pending.set(previousSessionFile, value);
		},
		take: (previousSessionFile) => {
			const value = pending.get(previousSessionFile);
			pending.delete(previousSessionFile);
			return value;
		},
		release: (previousSessionFile) => {
			pending.delete(previousSessionFile);
		},
	};
}
