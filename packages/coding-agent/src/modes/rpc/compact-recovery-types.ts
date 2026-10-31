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

/**
 * Why a token needs repair. A token minted for another peer or session is `unknown_token` (RULING-56 (1)): the
 * asker learns nothing about a stream that is not its own.
 */
export type RepairReason =
	| "unknown_token"
	| "released"
	| "lane_retired"
	| "stale_epoch"
	| "peer_gone"
	| "session_closed";

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

/** Every reason a token operation is refused with: a repair reason, a superseded token, or unavailable storage. */
export type RefusalReason = RepairReason | SupersededToken["reason"] | "storage_unavailable";

function assertNever(value: never): never {
	throw new Error(`unexpected recovery failure: ${JSON.stringify(value)}`);
}

export function refusalReason(failure: RecoveryFailure): RefusalReason {
	switch (failure.kind) {
		case "storage_unavailable":
			return failure.kind;
		case "repair_needed":
			return failure.reason;
		default:
			return assertNever(failure);
	}
}

export type RecoveryOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly failure: RecoveryFailure };

/**
 * One peer + session stream as a holder may read it (RULING-42 Q2 A): the session incarnation it materializes, its
 * generation (the number every token of it carries) and the admissions routed through it.
 */
export interface RecoveryStreamState {
	readonly sessionEpoch: string;
	readonly generation: number;
	readonly routes: readonly string[];
}

/** The owner's counters: open tokens, live streams, tokens frozen, roots reclaimed without a release, refusals by reason. */
export interface RecoveryCounters {
	readonly open: number;
	readonly streams: number;
	readonly frozen: number;
	readonly reclaimed: number;
	readonly refused: Readonly<Partial<Record<RefusalReason, number>>>;
}

export const recovered = <T>(value: T): RecoveryOutcome<T> => ({ ok: true, value });
export const repairNeeded = (reason: RepairReason): RecoveryFailure => ({ kind: "repair_needed", reason });
export const storageUnavailable = (reason: string): RecoveryFailure => ({ kind: "storage_unavailable", reason });

/** Thrown inside a token's operation lease when the cut stopped being valid; mapped to its failure by the owner. */
export class RecoveryRefusedError extends Error {
	readonly failure: RecoveryFailure;

	constructor(failure: RecoveryFailure) {
		super(`recovery refused (${failure.kind}: ${failure.reason})`);
		this.name = "RecoveryRefusedError";
		this.failure = failure;
	}
}
