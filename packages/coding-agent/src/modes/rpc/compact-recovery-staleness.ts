import type { RecoveryStreamRecord } from "./compact-recovery-streams.ts";
import type { CheckpointToken, RecoveryAdmission, RecoveryFailure } from "./compact-recovery-types.ts";
import type { SessionAcceptanceLane } from "./session-acceptance-lane.ts";

/** What the asker's stream says about its own token no longer owned here: the bounded description it gets. */
export function retiredTokenFailure(
	stream: RecoveryStreamRecord | undefined,
	admission: RecoveryAdmission,
): RecoveryFailure {
	if (!stream) return { kind: "repair_needed", reason: "unknown_token" };
	if (stream.sessionEpoch !== admission.sessionEpoch) return { kind: "repair_needed", reason: "stale_epoch" };
	if (stream.generation !== admission.generation)
		return { kind: "repair_needed", reason: "superseded_token", newerGeneration: stream.generation };
	return { kind: "repair_needed", reason: "unknown_token" };
}

/** Why a once-valid token no longer names a readable cut; undefined while it still does. */
export function tokenStaleness(
	stream: RecoveryStreamRecord | undefined,
	token: CheckpointToken,
	lane: SessionAcceptanceLane,
): RecoveryFailure | undefined {
	if (!stream && lane.retirement === "close") return { kind: "repair_needed", reason: "session_closed" };
	if (lane.retired) return { kind: "repair_needed", reason: "lane_retired" };
	if (!stream) return { kind: "repair_needed", reason: "peer_gone" };
	if (lane.sessionEpoch !== token.cut.sessionEpoch || stream.sessionEpoch !== token.admission.sessionEpoch)
		return { kind: "repair_needed", reason: "stale_epoch" };
	if (stream.generation !== token.admission.generation)
		return { kind: "repair_needed", reason: "superseded_token", newerGeneration: stream.generation };
	return undefined;
}
