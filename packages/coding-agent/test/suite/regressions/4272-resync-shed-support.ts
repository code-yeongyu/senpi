import type { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";

/** How a shed's recovery ends: the gap delivered, the drain failing, the session sealed, or the peer dropped. */
export type ShedEnd = "takeSnapshot" | "drain_failure" | "close_session" | "abort_seal" | "peer_drop";

/**
 * One resync-capable peer whose transport is held full, so the next records overflow its queue and the actor
 * sheds. `end` then finishes that shed through one path; `lane` is registered only when given.
 */
export async function shedThenEnd(end: ShedEnd, lane?: SessionAcceptanceLane) {
	const writes: string[] = [];
	const transport = Promise.withResolvers<void>();
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection(
		"peer",
		{ writeRaw: (line) => writes.push(line), waitForBackpressure: () => transport.promise },
		{ maxQueueBytes: 400 },
	);
	writer.setConnectionCapabilities("peer", [EVENT_RESYNC_CAPABILITY]);
	writer.attachConnectionToSession("peer", "s");
	if (lane) writer.registerAcceptance("s", lane);
	for (let index = 0; index < 8; index++)
		writer.enqueue("s", { type: "message_update", message: { role: "assistant", content: "x".repeat(60) }, index });
	const liveDuringShed = lane?.liveRoots;
	if (end === "takeSnapshot") {
		transport.resolve();
		await writer.flushConnection("peer");
	} else if (end === "drain_failure") {
		transport.reject(new Error("peer transport failed"));
		await writer.flushConnection("peer").catch(() => undefined);
	} else if (end === "peer_drop") writer.unregisterConnection("peer");
	else if (end === "close_session")
		writer.closeSession("s", { type: "response", command: "close_session", success: true });
	else writer.sealLifecycle("s", { type: "session_closed", sessionId: "s", reason: "error" });
	const liveAfter = lane?.liveRoots;
	const retired = lane?.retired;
	writer.unregisterConnection("peer");
	return { writes, liveDuringShed, liveAfter, retired };
}
