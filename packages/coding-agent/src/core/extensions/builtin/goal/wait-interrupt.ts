import type { ExtensionContext } from "../../types.ts";
import type { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import { isStaleExtensionContextError } from "./stale-context.ts";

export function registerGoalWaitInterrupt(
	ctx: ExtensionContext,
	continuation: MonitorAwareGoalContinuation,
	onUserAbort: (ctx: ExtensionContext) => Promise<void>,
): (() => void) | undefined {
	if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.onIdleEscape !== "function") return undefined;
	return ctx.ui.onIdleEscape(() => {
		if (continuation.scheduledContinuation() !== "monitor" || !ctx.isIdle()) return false;
		continuation.cancelWait();
		void onUserAbort(ctx)
			.then(() => ctx.ui.notify("Goal continuation stopped. Run /goal resume to continue.", "info"))
			.catch((error: unknown) => {
				if (isStaleExtensionContextError(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not stop the goal: ${message}. Try /goal pause.`, "error");
			});
		return true;
	});
}
