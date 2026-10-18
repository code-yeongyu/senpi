import type { ExtensionContext } from "../../types.ts";

/** Restored history is not admission; real activity or a completed turn is. */
export function createStartupActivityGate() {
	let waiting = false;
	let unsubscribe: (() => void) | undefined;

	function release(): void {
		waiting = false;
		unsubscribe?.();
		unsubscribe = undefined;
	}

	return {
		get waiting() {
			return waiting;
		},
		start(ctx: ExtensionContext, onActivity: () => void): void {
			release();
			waiting = true;
			unsubscribe = ctx.onUserActivity?.(() => {
				release();
				onActivity();
			});
		},
		release,
	};
}
