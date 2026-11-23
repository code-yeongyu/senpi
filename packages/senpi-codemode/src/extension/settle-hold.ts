import { randomUUID } from "node:crypto";

export interface SettleHoldLifecycle {
	readonly obligations: {
		open(key: string, kind: "background", detail?: string): { close(reason: "consumed"): void };
	};
}

/**
 * Holds the session open while a detached cell's completion notification waits for its written files to settle: the
 * engine takes custody of a notification only when it is delivered, so without the hold the run could report done
 * with a notification still owed.
 */
export function createSettleHold(lifecycle: SettleHoldLifecycle | undefined): (() => () => void) | undefined {
	if (lifecycle === undefined) return undefined;
	return () => {
		const token = lifecycle.obligations.open(
			`eval-settle:${randomUUID()}`,
			"background",
			"eval cell result settling",
		);
		return () => token.close("consumed");
	};
}
