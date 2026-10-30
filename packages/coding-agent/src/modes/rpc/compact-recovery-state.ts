import type { TranscriptRoot } from "./accepted-transcript.ts";
import { CompactReadError, CompactReadLease } from "./compact-read-lease.ts";
import {
	type CheckpointToken,
	type RecoveryAdmission,
	type RecoveryCaller,
	type RecoveryFailure,
	type RecoveryOutcome,
	RecoveryRefusedError,
	type RecoveryToken,
	recovered,
	repairNeeded,
	storageUnavailable,
} from "./compact-recovery-types.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";

/** A frozen checkpoint: its token, and the lane root the legacy view reader (S07b) reads under the lane. */
export interface FrozenCheckpoint {
	readonly token: CheckpointToken;
	readonly lane: SessionAcceptanceLane;
	readonly root: FrozenAcceptedRoot;
}

interface Checkpoint extends FrozenCheckpoint {
	readonly lease: CompactReadLease;
}

/** An admission's route; its session epoch and generation come from the lane and the stream at the freeze. */
export type RecoveryRoute = Omit<RecoveryAdmission, "sessionEpoch" | "generation">;

const streamOf = ({
	socketEpoch,
	sessionId,
	sessionEpoch,
}: Pick<RecoveryAdmission, "socketEpoch" | "sessionId" | "sessionEpoch">): string =>
	`${socketEpoch}\u0000${sessionId}\u0000${sessionEpoch}`;

/**
 * The checkpoint tokens of one host (S08a, R3.C1.2-C1.5). A freeze pins one complete accepted root in one
 * synchronous step and mints a token naming the cut's accepted identities; nothing is published when the root is
 * incomplete. Every lookup validates the caller, the token and the cut before I/O and after every await, under the
 * token's operation lease: invalidation is immediate, the root is released once the last operation unwinds.
 */
export class RecoveryCheckpoints {
	private readonly checkpoints = new Map<string, Checkpoint>();
	private readonly generations = new Map<string, number>();
	private minted = 0;

	get open(): number {
		return this.checkpoints.size;
	}

	tokens(): readonly CheckpointToken[] {
		return [...this.checkpoints.values()].map(({ token }) => token);
	}

	/** The next materialization of the route's stream: a failed freeze advances nothing and pins nothing. */
	freeze(route: RecoveryRoute, lane: SessionAcceptanceLane): RecoveryOutcome<FrozenCheckpoint> {
		if (lane.retired) return repairNeeded("lane_retired");
		const root = lane.freeze();
		if (root.current === undefined) {
			lane.release(root);
			return storageUnavailable("compact_state_unavailable");
		}
		const stream = streamOf({ ...route, sessionEpoch: root.sessionEpoch });
		const generation = (this.generations.get(stream) ?? 0) + 1;
		this.generations.set(stream, generation);
		const token: CheckpointToken = {
			kind: "checkpoint",
			id: `${route.socketEpoch}:${++this.minted}`,
			admission: { ...route, sessionEpoch: root.sessionEpoch, generation },
			cut: {
				sessionEpoch: root.sessionEpoch,
				sequence: root.sequence,
				historyVersion: root.transcript.historyVersion,
				leafId: root.transcript.leafId,
				activeMessageId: root.activeMessageId,
				turnId: root.turnId,
			},
		};
		const checkpoint: Checkpoint = {
			token,
			lane,
			root,
			lease: new CompactReadLease(
				() => {
					lane.release(root);
					this.checkpoints.delete(token.id);
				},
				() => {
					const stale = this.staleness(token, lane);
					if (stale) throw new RecoveryRefusedError(stale);
				},
			),
		};
		this.checkpoints.set(token.id, checkpoint);
		return recovered(checkpoint);
	}

	/** Idempotent, and never another token's: the root goes once this token's last operation unwinds. */
	release(token: RecoveryToken): void {
		this.checkpoints.get(token.id)?.lease.release();
	}

	/**
	 * A peer incarnation is gone: its streams end and every checkpoint it froze is released whether or not its holder
	 * ever releases it (the bound on a never-releasing holder, RULING-50 (2)); an operation still in flight on one is
	 * refused as `peer_gone` and its root goes once that operation unwinds.
	 */
	forgetPeer(socketEpoch: string): void {
		for (const stream of this.generations.keys())
			if (stream.startsWith(`${socketEpoch}\u0000`)) this.generations.delete(stream);
		for (const { token, lease } of [...this.checkpoints.values()])
			if (token.admission.socketEpoch === socketEpoch) lease.release();
	}

	/** The pinned transcript root (version, leaf, accepted ids, base identity); its bytes are read by S11's page route. */
	transcript(token: RecoveryToken, caller: RecoveryCaller): RecoveryOutcome<TranscriptRoot> {
		const claimed = this.claim(token, caller);
		if (!claimed.ok) return claimed;
		const { transcript } = claimed.value.root;
		return transcript.unavailable === null ? recovered(transcript) : storageUnavailable(transcript.unavailable);
	}

	readSettled(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readSettled(root));
	}

	readCurrent(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrent(root));
	}

	readComponents(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrentComponents(root));
	}

	readActive(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrentActive(root));
	}

	readCalls(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root) => lane.readCurrentCalls(root));
	}

	private async read<T>(
		token: RecoveryToken,
		caller: RecoveryCaller,
		component: (lane: SessionAcceptanceLane, root: FrozenAcceptedRoot) => Promise<T>,
	): Promise<RecoveryOutcome<T>> {
		const claimed = this.claim(token, caller);
		if (!claimed.ok) return claimed;
		const { lease, lane, root } = claimed.value;
		try {
			return recovered(await lease.run(() => component(lane, root)));
		} catch (cause) {
			return this.refused(token, lane, cause);
		}
	}

	/** Owner, route, session epoch, generation and token, checked before any I/O. */
	private claim(token: RecoveryToken, caller: RecoveryCaller): RecoveryOutcome<Checkpoint> {
		const checkpoint = this.checkpoints.get(token.id);
		if (!checkpoint || checkpoint.token !== token) return repairNeeded("unknown_token");
		if (token.admission.socketEpoch !== caller.socketEpoch) return repairNeeded("foreign_peer");
		if (token.admission.sessionId !== caller.sessionId) return repairNeeded("foreign_session");
		try {
			checkpoint.lease.assert();
		} catch (cause) {
			return this.refused(token, checkpoint.lane, cause);
		}
		return recovered(checkpoint);
	}

	/** Why a once-valid token no longer names a readable cut; undefined while it still does. */
	private staleness(token: CheckpointToken, lane: SessionAcceptanceLane): RecoveryFailure | undefined {
		if (lane.retired) return { kind: "repair_needed", reason: "lane_retired" };
		if (lane.sessionEpoch !== token.cut.sessionEpoch) return { kind: "repair_needed", reason: "stale_epoch" };
		const current = this.generations.get(streamOf(token.admission));
		if (current === undefined) return { kind: "repair_needed", reason: "peer_gone" };
		if (current !== token.admission.generation)
			return { kind: "repair_needed", reason: "superseded_token", newerGeneration: current };
		return undefined;
	}

	/** A refused operation names the cut's staleness first; a store that could not serve it is storage_unavailable. */
	private refused(token: CheckpointToken, lane: SessionAcceptanceLane, cause: unknown): RecoveryOutcome<never> {
		const stale = this.staleness(token, lane);
		if (stale) return { ok: false, failure: stale };
		if (cause instanceof RecoveryRefusedError) return { ok: false, failure: cause.failure };
		if (cause instanceof CompactReadError)
			return cause.reason === "released" ? repairNeeded("released") : storageUnavailable(cause.reason);
		throw cause;
	}
}
