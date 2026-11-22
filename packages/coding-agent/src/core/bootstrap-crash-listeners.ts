type CrashEvent = "uncaughtException" | "unhandledRejection";

const modeHandlers = new WeakSet<(...args: never[]) => unknown>();

/** Registers a mode's own crash handler (interactive); bootstrap listeners defer only to these. */
export function markModeCrashHandler(listener: (...args: never[]) => unknown): void {
	modeHandlers.add(listener);
}

/**
 * True when a mode has registered its own handler for `event`. Only explicitly marked handlers count,
 * so neither another bootstrap listener nor an unrelated library listener can silence a real crash.
 */
export function hasModeCrashHandler(event: CrashEvent): boolean {
	return process.listeners(event).some((listener) => modeHandlers.has(listener));
}
