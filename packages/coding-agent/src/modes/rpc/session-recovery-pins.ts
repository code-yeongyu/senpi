import { legacyResyncMessage } from "./compact-legacy-view.ts";
import type { FrozenCheckpoint, RecoveryCheckpoints } from "./compact-recovery-state.ts";
import { type RecoveryOutcome, recovered } from "./compact-recovery-types.ts";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { resyncCut } from "./legacy-resync-view.ts";
import type { LegacyReplayStore } from "./legacy-replay-store.ts";
import type { SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import type { ResyncCut, ResyncReason } from "./socket-peer-recovery.ts";
import type { ShedMode } from "./socket-peer-shed.ts";

/**
 * A lane-owned session pinned for one frozen view (R3.C1.5): the freeze outcome, so a view can tell a retired lane
 * from unavailable storage, and the lane's epoch at the pin, the incarnation the view's liveness is bound to.
 */
export interface PinnedSession {
	readonly sessionId: string;
	readonly lane: SessionAcceptanceLane;
	readonly sessionEpoch: string;
	readonly outcome: RecoveryOutcome<FrozenCheckpoint>;
}

/** What the pins read of the fanout's peers: a registration's incarnation and the attach ordinals it holds. */
export interface RecoveryPeers {
	socketEpoch(id: string): string | undefined;
	/** Per attached session, the ordinal of the attach that holds it for `id`; undefined for an unknown peer. */
	ordinals(id: string): ReadonlyMap<string, number> | undefined;
	has(id: string, capability: string): boolean;
}

const admissionOf = (ordinal: number): string => `attach-${ordinal}`;

/**
 * The checkpoints a host pins for its peers' legacy views (S08a producers): one per held lane-owned session on the
 * admission (the attach ordinal) that holds it, and the shed's recovery cut read from them.
 */
export class SessionRecoveryPins {
	private readonly acceptance: ReadonlyMap<string, SessionAcceptanceLane>;
	private readonly checkpoints: RecoveryCheckpoints;
	private readonly replay: LegacyReplayStore;
	private readonly peers: RecoveryPeers;
	private readonly shedMode: ShedMode;

	constructor(
		acceptance: ReadonlyMap<string, SessionAcceptanceLane>,
		checkpoints: RecoveryCheckpoints,
		replay: LegacyReplayStore,
		peers: RecoveryPeers,
		shedMode: ShedMode,
	) {
		this.acceptance = acceptance;
		this.checkpoints = checkpoints;
		this.replay = replay;
		this.peers = peers;
		this.shedMode = shedMode;
	}

	/** One freeze per held lane-owned session, on the admission (the attach ordinal) that holds it for `id`. */
	pin(id: string, sessionIds: readonly string[]): readonly PinnedSession[] {
		const socketEpoch = this.peers.socketEpoch(id);
		return sessionIds.flatMap((sessionId) => {
			const lane = this.acceptance.get(sessionId);
			const ordinal = this.peers.ordinals(id)?.get(sessionId);
			if (!lane || ordinal === undefined || socketEpoch === undefined) return [];
			const route = {
				socketEpoch,
				admissionId: admissionOf(ordinal),
				routeKind: "ordinary" as const,
				peer: id,
				sessionId,
			};
			return [{ sessionId, lane, sessionEpoch: lane.sessionEpoch, outcome: this.checkpoints.freeze(route, lane) }];
		});
	}

	unpin(pinned: readonly PinnedSession[]): void {
		for (const { outcome } of pinned) if (outcome.ok) this.checkpoints.release(outcome.value.token);
	}

	/** The admission holding `sessionId` for `id` ends (a detach): its route leaves its stream. */
	retire(id: string, sessionId: string): void {
		const socketEpoch = this.peers.socketEpoch(id);
		const ordinal = this.peers.ordinals(id)?.get(sessionId);
		if (socketEpoch !== undefined && ordinal !== undefined)
			this.checkpoints.retireRoute({ socketEpoch, sessionId }, admissionOf(ordinal));
	}

	/**
	 * The shed's recovery: checkpoints frozen at the shed, before the actor awaits its drain (R3.C1.5), as the next
	 * generation of each held admission; released when the recovery ends. The cut owns each root from the freeze to
	 * that end: a detach, re-attach or supersession before its gap is delivered retires the token, never the root.
	 */
	resync(id: string, reason: ResyncReason, carried: readonly string[] = []): ResyncCut {
		const capture = this.shedMode === "capture";
		const attached = [...(this.peers.ordinals(id)?.keys() ?? [])];
		const ordinals = new Map(this.peers.ordinals(id));
		const pinned = this.pin(id, attached);
		const roots = new Map(
			pinned.map(({ sessionId, outcome }) => [sessionId, outcome.ok ? recovered(outcome.value.retain()) : outcome]),
		);
		const view = {
			reason,
			placeholders: this.peers.has(id, MEDIA_PLACEHOLDERS_CAPABILITY),
			// Capture: closed once the attachment held at the shed is gone (carry 30); drop: today's rule.
			closedNow: (sessionId: string) =>
				capture
					? this.peers.ordinals(id)?.get(sessionId) !== ordinals.get(sessionId) || !ordinals.has(sessionId)
					: !(this.peers.ordinals(id)?.has(sessionId) ?? false),
			onRelease: () => {
				for (const root of roots.values()) if (root.ok) root.value.end();
				this.unpin(pinned);
			},
		};
		const sessions = capture ? [...new Set([...carried, ...attached])] : attached;
		return resyncCut(
			sessions,
			capture ? () => sessions : () => [...new Set([...sessions, ...(this.peers.ordinals(id)?.keys() ?? [])])],
			(sessionId) =>
				this.acceptance.has(sessionId)
					? legacyResyncMessage(sessionId, roots.get(sessionId))
					: Promise.resolve(this.replay.latestMessage(sessionId)),
			view,
			this.replay.track,
		);
	}
}
