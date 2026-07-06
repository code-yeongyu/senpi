import type { TimeoutPauseHandle } from "./idle-timeout.ts";

export async function withBridgeTimeoutPause<T>(
	watchdog: TimeoutPauseHandle | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	if (watchdog === undefined) return operation();
	watchdog.pause();
	try {
		return await operation();
	} finally {
		watchdog.resume();
	}
}
