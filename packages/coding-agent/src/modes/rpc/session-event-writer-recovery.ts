import { COMPACT_RECORD_MAX_BYTES, type EventLeases } from "./compact-event-leases.ts";
import type { RecoveryPageRequests } from "./compact-recovery-requests.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import { COMPACT_EVENTS_CAPABILITY } from "./custom-capability.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { SessionEventWriterLifecycle } from "./session-event-writer-lifecycle.ts";

/** The writer's recovery accessors (senpi#4272): legacy views, checkpoint tokens, page requests, peer epochs. */
export abstract class SessionEventWriterRecovery extends SessionEventWriterLifecycle {
	/** Legacy views frozen for a peer's baseline and not yet released (R3.C6.4 accounting). */
	get openLegacyViews(): number {
		return this.fanout.replay.openCursors;
	}

	/** The checkpoint tokens frozen for peers' baselines and recoveries (S08a, R3.C1.5). */
	get recoveryCheckpoints(): RecoveryCheckpoints {
		return this.fanout.checkpoints;
	}

	/** The page requests over those tokens (S11b, R4.B3); undefined with the compact-updates flag off. */
	get recoveryPages(): RecoveryPageRequests | undefined {
		return this.fanout.pages;
	}

	/** The ordinary-event leases (S13, R4.B6); undefined with the compact-updates flag off. */
	get recoveryEvents(): EventLeases | undefined {
		return this.fanout.events;
	}

	/** The peer incarnation a registered connection is: what its tokens and cursors are bound to. */
	socketEpochOf(id: string): string | undefined {
		return this.fanout.get(id)?.socketEpoch;
	}

	/**
	 * What `target` receives for `record` serialized as `line` (S13, R4.B6): a record past F, for a connection that
	 * selected compact events and holds this lane-owned session, becomes an `eventLease` envelope at the record's accepted
	 * sequence; every other destination gets `line`. Past the peer's lease bound, or when the record cannot be staged,
	 * the peer gets a typed refusal and its connection closes (fail closed, like a plain peer's overflow).
	 */
	protected eventLine(target: string, sessionId: string, record: object, line: string): string {
		const events = this.fanout.events;
		const lane = this.fanout.acceptance.get(sessionId);
		const admissionId = this.fanout.admissionOf(target, sessionId);
		const socketEpoch = this.fanout.get(target)?.socketEpoch;
		if (!events || !lane || admissionId === undefined || socketEpoch === undefined) return line;
		if (!this.fanout.connectionHas(target, COMPACT_EVENTS_CAPABILITY)) return line;
		if (Buffer.byteLength(line) <= COMPACT_RECORD_MAX_BYTES) return line;
		const at = { sessionEpoch: lane.sessionEpoch, sequence: lane.acceptedSequence };
		const minted = events.mint({ socketEpoch, sessionId, admissionId }, at, record, line);
		if (minted.ok)
			return serializeJsonLine({ type: Reflect.get(record, "type"), sessionId, eventLease: minted.value });
		process.stderr.write(`senpi rpc connection ${target} event lease refused (${minted.reason}); closing\n`);
		this.fanout.get(target)?.connection.close?.();
		return serializeJsonLine({ type: "event_lease_refused", sessionId, reason: minted.reason });
	}
}
