import { isStaleExtensionContextError } from "../goal/stale-context.ts";

/** Deferred terminal callbacks stop using a retired generation; other failures remain visible. */
export function withTerminalContext<T>(callback: () => T, retire: () => void): T | undefined {
	try {
		return callback();
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
		retire();
		return undefined;
	}
}
