import type { ExtensionAPI } from "../../types.ts";
import type { DelayedContinuationKind } from "./monitor-continuation-types.ts";
import { isStaleExtensionContextError } from "./stale-context.ts";

/** RPC request a client sends to run the armed continuation now instead of at its due time (senpi#3196). */
export const GOAL_CONTINUATION_FIRE_NOW_REQUEST = "goal_continuation_fire_now";

export type GoalContinuationFireNowResult =
	| { readonly fired: true; readonly kind: DelayedContinuationKind }
	| { readonly fired: false; readonly reason: "not_armed" | "held" };

/**
 * Publishes a continuation event to in-process listeners and, as an `extension_event`, to RPC
 * clients, so a desktop thread shows the same wait the TUI's ticker shows. A retired runtime
 * cannot reach a client; its staleness is expected there and is dropped.
 */
export function publishGoalContinuationEvent(pi: ExtensionAPI, name: string, data: unknown): void {
	pi.events?.emit(name, data);
	try {
		pi.rpc?.emit(name, data);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
	}
}

export function registerGoalFireNowRequest(
	pi: ExtensionAPI,
	fireNow: () => Promise<GoalContinuationFireNowResult>,
): void {
	pi.rpc?.handle(GOAL_CONTINUATION_FIRE_NOW_REQUEST, () => fireNow());
}
