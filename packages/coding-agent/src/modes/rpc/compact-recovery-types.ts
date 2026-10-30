/** How a peer reaches a routing session: its own attachment, or (S16) a mirror of another destination's stream. */
export type RecoveryRouteKind = "ordinary" | "mirror";

/**
 * One admission of a peer to a routing session (R3.C4, RULING-46 item 1): the descriptor S08 consumes and S15/S16
 * later construct unchanged. `admissionId` is opaque and bounded, and no consumer orders by it. `generation` is the
 * materialization generation of the peer + session-incarnation stream the admission belongs to (RULING-42 Q2).
 */
export interface RecoveryAdmission {
	readonly socketEpoch: string;
	readonly admissionId: string;
	readonly routeKind: RecoveryRouteKind;
	readonly peer: string;
	readonly sessionId: string;
	readonly sessionEpoch: string;
	readonly generation: number;
}

/** Who asks for a token: the peer incarnation and the routing session the lookup is for. */
export type RecoveryCaller = Pick<RecoveryAdmission, "socketEpoch" | "sessionId">;

/** The identity of one frozen cut C (R3.C1.2): what the accepted owners pinned, never a recovery counter. */
export interface RecoveryCutIdentity {
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly historyVersion: number;
	readonly leafId: string | null;
	readonly activeMessageId: string | null;
	readonly turnId: string | null;
}

/** A checkpoint token (R3.C1.5), tagged so S13 can add an event-lease variant without changing S08's callers. */
export interface CheckpointToken {
	readonly kind: "checkpoint";
	readonly id: string;
	readonly admission: RecoveryAdmission;
	readonly cut: RecoveryCutIdentity;
}

export type RecoveryToken = CheckpointToken;

export type RepairReason =
	| "unknown_token"
	| "released"
	| "foreign_peer"
	| "foreign_session"
	| "lane_retired"
	| "stale_epoch"
	| "peer_gone";

/** A token of an older generation of its stream (RULING-50 (2)): `newerGeneration` is the stream's current one. */
export interface SupersededToken {
	readonly kind: "repair_needed";
	readonly reason: "superseded_token";
	readonly newerGeneration: number;
}

/**
 * The typed failure of every token operation (S14-Q2 shape): `repair_needed` when the consumer must admit again
 * (its token is retired, foreign, superseded or its peer is gone), `storage_unavailable` when the host could not
 * serve the pinned cut.
 */
export type RecoveryFailure =
	| { readonly kind: "repair_needed"; readonly reason: RepairReason }
	| SupersededToken
	| { readonly kind: "storage_unavailable"; readonly reason: string };

export type RecoveryOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly failure: RecoveryFailure };

export const recovered = <T>(value: T): RecoveryOutcome<T> => ({ ok: true, value });
export const repairNeeded = (reason: RepairReason): RecoveryOutcome<never> => ({
	ok: false,
	failure: { kind: "repair_needed", reason },
});
export const storageUnavailable = (reason: string): RecoveryOutcome<never> => ({
	ok: false,
	failure: { kind: "storage_unavailable", reason },
});

/** Thrown inside a token's operation lease when the cut stopped being valid; mapped to its failure by the owner. */
export class RecoveryRefusedError extends Error {
	readonly failure: RecoveryFailure;

	constructor(failure: RecoveryFailure) {
		super(`recovery refused (${failure.kind}: ${failure.reason})`);
		this.name = "RecoveryRefusedError";
		this.failure = failure;
	}
}
