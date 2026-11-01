import { liveSessionWritePaths } from "../../core/session-write-reservation.ts";
import { buildRpcSessionState } from "./connection-handler.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import type { RpcSessionEntry } from "./session-registry.ts";
import type { WorkerSnapshot } from "./session-worker-protocol.ts";

/** The worker isolate's whole-state snapshot of its one session, built only when a message carries it. */
export function workerSnapshot(entry: RpcSessionEntry | undefined): WorkerSnapshot {
	if (!entry?.runtime) throw new Error("Session runtime is not ready");
	const session = entry.runtime.session;
	const sessionPath = session.sessionFile ? canonicalSessionPath(session.sessionFile) : undefined;
	// The host releases every granted path this list omits, so it must name each writer
	// still alive in this isolate, plus the session the runtime currently writes.
	const live = new Set(liveSessionWritePaths().map(canonicalSessionPath));
	if (sessionPath) live.add(sessionPath);
	return {
		state: buildRpcSessionState(session),
		sessionPath,
		liveSessionPaths: [...live],
		busy: session.isSessionBusy,
		handoffBusy: isHandoffBusy(session.activitySnapshot),
		streaming: session.isStreaming,
	};
}
