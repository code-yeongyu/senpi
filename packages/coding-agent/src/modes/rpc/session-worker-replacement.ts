import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import type { SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import type { SessionWorkerCallbacks } from "./session-worker-callbacks.ts";
import type { SessionWorkerToHost } from "./session-worker-protocol.ts";

/** Reserve the replacement identity before bootstrap publishes its first cut and returns the worker's credit. */
export async function reconcileWorkerReplacement(
	message: Extract<SessionWorkerToHost, { type: "output" }>,
	lane: SessionAcceptanceLane | undefined,
	callbacks: SessionWorkerCallbacks,
): Promise<void> {
	if (!message.snapshot) return;
	if (message.bootstrap && compactUpdatesEnabled()) await lane?.generations.bind(message.snapshot.state.sessionId);
	await callbacks.reconcile(message.snapshot.liveSessionPaths);
}
