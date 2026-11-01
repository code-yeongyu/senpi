import type { TranscriptRoot } from "./accepted-transcript.ts";
import { CompactReadError, CompactReadLease } from "./compact-read-lease.ts";
import { RecoveryManifests } from "./compact-recovery-manifest.ts";
import { RecoveryStreams } from "./compact-recovery-streams.ts";
import type { FrozenCheckpoint } from "./compact-recovery-checkpoint-types.ts";
export type { FrozenCheckpoint, RetainedRoot } from "./compact-recovery-checkpoint-types.ts";
import {
	type CheckpointToken,
	type RecoveryCaller,
	type RecoveryCounters,
	type RecoveryFailure,
	type RecoveryOutcome,
	type RecoveryAdmission,
	RecoveryRefusedError,
	type RecoveryStreamState,
	type RecoveryToken,
	type RefusalReason,
	type StorageUnavailableReason,
	recovered,
	refusalReason,
	repairNeeded,
	storageUnavailable,
} from "./compact-recovery-types.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";

interface Checkpoint extends FrozenCheckpoint {
	readonly lease: CompactReadLease;
}

/** An admission's route; its session epoch and generation come from the lane and the stream at the freeze. */
export type RecoveryRoute = Omit<RecoveryAdmission, "sessionEpoch" | "generation">;

/**
 * The checkpoint tokens of one host (S08a/S08b, R3.C1.2-C1.5). A freeze pins one complete accepted root in one
 * synchronous step and mints a token naming the cut's accepted identities as the next generation of its stream;
 * nothing is published when the root is incomplete. Issuing a generation invalidates the stream's previous token
 * at once and reclaims its root as soon as the operations in flight on it unwind, whether or not its holder ever
 * releases it. Every lookup validates the caller, the token and the cut before I/O and after every await.
 */
export class RecoveryCheckpoints {
	private readonly checkpoints = new Map<string, Checkpoint>();
	/** Every token minted here, with the admission it was minted for; a holder's copy or a forgery is not in it. */
	private readonly issued = new WeakMap<RecoveryToken, RecoveryAdmission>();
	private readonly streams = new RecoveryStreams();
	private readonly manifests = new RecoveryManifests();
	private readonly refusals = new Map<RefusalReason, number>();
	private readonly unavailable = new Map<StorageUnavailableReason, number>();
	private readonly ended = new Set<(tokenId: string) => void>();
	private minted = 0;
	private frozen = 0;
	private reclaimed = 0;

	get open(): number {
		return this.checkpoints.size;
	}

	tokens(): readonly CheckpointToken[] {
		return [...this.checkpoints.values()].map(({ token }) => token);
	}

	/** The stream a caller's admissions share, as a bounded description; undefined once its peer or session ended. */
	stream(caller: RecoveryCaller): RecoveryStreamState | undefined {
		return this.streams.describe(caller);
	}

	/** Runs once per token when its lease ends, however it ended (a release, a reclaim, its peer's end). */
	onTokenEnd(listener: (tokenId: string) => void): void {
		this.ended.add(listener);
	}

	status(): RecoveryCounters {
		return {
			open: this.checkpoints.size,
			streams: this.streams.size,
			frozen: this.frozen,
			reclaimed: this.reclaimed,
			refused: Object.fromEntries(this.refusals),
			unavailable: Object.fromEntries(this.unavailable),
		};
	}

	/** The next generation of the route's stream: a failed freeze advances nothing and pins nothing. */
	freeze(route: RecoveryRoute, lane: SessionAcceptanceLane, join = false): RecoveryOutcome<FrozenCheckpoint> {
		if (lane.retired) return this.refuse(repairNeeded("lane_retired"));
		const current = join ? this.checkpoints.get(this.streams.get(route)?.current ?? "") : undefined;
		if (current && this.check(current.token, route).ok) {
			this.streams.join(route);
			return recovered(current);
		}
		const root = lane.freeze();
		if (root.current === undefined) {
			lane.release(root);
			return this.refuse(storageUnavailable("compact_state_unavailable"));
		}
		const id = `${route.socketEpoch}:${++this.minted}`;
		// One token per root (RULING-69 (2)): a root already pinned is a broken invariant, thrown before any stream moves.
		this.manifests.pin(id, root);
		const { generation, retired } = this.streams.next(route, root.sessionEpoch, id);
		const admission: RecoveryAdmission = Object.freeze({ ...route, sessionEpoch: root.sessionEpoch, generation });
		const token: CheckpointToken = Object.freeze({
			kind: "checkpoint",
			id,
			admission,
			cut: Object.freeze({
				sessionEpoch: root.sessionEpoch,
				sequence: root.sequence,
				historyVersion: root.transcript.historyVersion,
				leafId: root.transcript.leafId,
				activeMessageId: root.activeMessageId,
				turnId: root.turnId,
			}),
		});
		const lease = new CompactReadLease(
			() => {
				this.manifests.release(token.id);
				lane.release(root);
				this.checkpoints.delete(token.id);
				for (const listener of this.ended) listener(token.id);
			},
			() => {
				const stale = this.staleness(token, lane);
				if (stale) throw new RecoveryRefusedError(stale);
			},
		);
		const checkpoint: Checkpoint = {
			token,
			lane,
			root,
			lease,
			hold: (read) => lease.hold(read),
			retain: () => ({ lane, root, hold: (read) => read(), end: lease.retain() }),
		};
		this.issued.set(token, admission);
		this.checkpoints.set(token.id, checkpoint);
		this.frozen += 1;
		this.reclaim(retired);
		return recovered(checkpoint);
	}

	/** Idempotent, and never another token's: the root goes once this token's last operation unwinds. */
	release(token: RecoveryToken): void {
		this.checkpoints.get(token.id)?.lease.release();
	}

	/**
	 * A peer incarnation is gone: its streams end and every checkpoint it froze is reclaimed whether or not its
	 * holder ever releases it (RULING-50 (2)); an operation still in flight on one is refused as `peer_gone` and
	 * its root goes once that operation unwinds.
	 */
	forgetPeer(socketEpoch: string): void {
		this.streams.forgetPeer(socketEpoch);
		for (const { token } of [...this.checkpoints.values()])
			if (token.admission.socketEpoch === socketEpoch) this.reclaim(token.id);
	}

	/**
	 * The routing session ended for good (RULING-56 (2)): its stream records go on every peer, since a sealed handle is
	 * never re-attached. Its tokens keep their lifetime (a queued attach view reads its root to delivery, RULING-51
	 * Q2 A); live access to one is refused as `session_closed`, read from its retired lane.
	 */
	forgetSession(sessionId: string): void {
		this.streams.forgetSession(sessionId);
	}

	/**
	 * An admission ended (a detach today; S14 extends this): its route leaves the stream, the counter stays, and the
	 * token it minted is reclaimed like a superseded one (RULING-56 (4)), with or without its stream record. Idempotent.
	 */
	retireRoute(caller: RecoveryCaller, admissionId: string): void {
		const current = this.streams.get(caller)?.current;
		this.streams.retireRoute(caller, admissionId);
		if ((this.streams.get(caller)?.routes.size ?? 0) > 0) return;
		this.reclaim(current);
		for (const { token } of [...this.checkpoints.values()]) {
			const { socketEpoch, sessionId, admissionId: minter } = token.admission;
			if (socketEpoch === caller.socketEpoch && sessionId === caller.sessionId && minter === admissionId)
				this.reclaim(token.id);
		}
	}

	/**
	 * The caller's claim on a token it named by id, before any request state is touched: a token superseded while an
	 * operation still holds it answers `superseded_token` with the newer generation (RULING-70 (3), RULING-50 (2)).
	 */
	check(token: RecoveryToken, caller: RecoveryCaller): RecoveryOutcome<RecoveryToken> {
		const claimed = this.claim(token, caller);
		return claimed.ok ? recovered(token) : claimed;
	}

	/** The pinned transcript root (version, leaf, accepted ids, base identity); its bytes are read by S11's page route. */
	transcript(token: RecoveryToken, caller: RecoveryCaller): RecoveryOutcome<TranscriptRoot> {
		const claimed = this.claim(token, caller);
		if (!claimed.ok) return claimed;
		const { transcript } = claimed.value.root;
		return transcript.unavailable === null
			? recovered(transcript)
			: this.refuse(storageUnavailable(transcript.unavailable));
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

	/** The bounded manifest of the cut (S09, R4.B1): built once per token from its pinned root, never a component list. */
	catalog(token: RecoveryToken, caller: RecoveryCaller) {
		return this.read(token, caller, (lane, root, lease) =>
			this.manifests.manifest(token, lane, root, () => lease.assert()),
		);
	}

	/** One catalog node or component under the token, verified against its parent's digest before it is decoded. */
	readCatalog(token: RecoveryToken, caller: RecoveryCaller, ref: string) {
		return this.read(token, caller, (lane, root) => this.manifests.read(token.id, lane, root, ref));
	}

	/**
	 * One bounded page (at most `FRAGMENT_MAX_BYTES` raw bytes) of a catalog component at a raw byte offset, under the
	 * same claim and lease as every read (S11a; the cursor, ordinal and request limits around it are S11b). `signal` is
	 * the request's budget: a first open's verification is charged to it and stops, typed `aborted`, when it aborts.
	 */
	readCatalogPage(token: RecoveryToken, caller: RecoveryCaller, ref: string, offset: number, signal?: AbortSignal) {
		return this.read(token, caller, (lane, root) => this.manifests.page(token, lane, root, ref, offset, signal));
	}

	/** Components verified under the live frozen roots (RULING-69 (2)); a root's entries go with its lease. */
	get verifiedComponents(): number {
		return this.manifests.verifiedComponents;
	}

	private async read<T>(
		token: RecoveryToken,
		caller: RecoveryCaller,
		component: (lane: SessionAcceptanceLane, root: FrozenAcceptedRoot, lease: CompactReadLease) => Promise<T>,
	): Promise<RecoveryOutcome<T>> {
		const claimed = this.claim(token, caller);
		if (!claimed.ok) return claimed;
		const { lease, lane, root } = claimed.value;
		try {
			return recovered(await lease.run(() => component(lane, root, lease)));
		} catch (cause) {
			return this.refused(token, lane, cause);
		}
	}

	/**
	 * Invalidates a token the owner retires (superseded, replaced, route retired, or its peer gone): the root goes after
	 * its in-flight operations. Counted only when this is what released it, never after its holder's own release.
	 */
	private reclaim(id: string | undefined): void {
		if (id !== undefined && this.checkpoints.get(id)?.lease.release()) this.reclaimed += 1;
	}

	/**
	 * Only a token minted here for the asking peer + session is looked at (RULING-56 (1)): anything else is
	 * `unknown_token` with no state. A retired one is then described by the asker's own stream before any I/O.
	 */
	private claim(token: RecoveryToken, caller: RecoveryCaller): RecoveryOutcome<Checkpoint> {
		const admission = this.issued.get(token);
		if (admission?.socketEpoch !== caller.socketEpoch || admission.sessionId !== caller.sessionId)
			return this.refuse(repairNeeded("unknown_token"));
		const checkpoint = this.checkpoints.get(token.id);
		if (!checkpoint) return this.refuse(this.describe(admission));
		try {
			checkpoint.lease.assert();
		} catch (cause) {
			return this.refused(token, checkpoint.lane, cause);
		}
		return recovered(checkpoint);
	}

	/** What the asker's stream says about its own token no longer owned here: the bounded description it gets. */
	private describe(admission: RecoveryAdmission): RecoveryFailure {
		const stream = this.streams.get(admission);
		if (!stream) return { kind: "repair_needed", reason: "unknown_token" };
		if (stream.sessionEpoch !== admission.sessionEpoch) return { kind: "repair_needed", reason: "stale_epoch" };
		if (stream.generation !== admission.generation)
			return { kind: "repair_needed", reason: "superseded_token", newerGeneration: stream.generation };
		return { kind: "repair_needed", reason: "unknown_token" };
	}

	/** Why a once-valid token no longer names a readable cut; undefined while it still does. */
	private staleness(token: CheckpointToken, lane: SessionAcceptanceLane): RecoveryFailure | undefined {
		const stream = this.streams.get(token.admission);
		if (!stream && lane.retirement === "close") return { kind: "repair_needed", reason: "session_closed" };
		if (lane.retired) return { kind: "repair_needed", reason: "lane_retired" };
		if (!stream) return { kind: "repair_needed", reason: "peer_gone" };
		if (lane.sessionEpoch !== token.cut.sessionEpoch || stream.sessionEpoch !== token.admission.sessionEpoch)
			return { kind: "repair_needed", reason: "stale_epoch" };
		if (stream.generation !== token.admission.generation)
			return { kind: "repair_needed", reason: "superseded_token", newerGeneration: stream.generation };
		return undefined;
	}

	/** A refused operation names the cut's staleness first; a store that could not serve it is storage_unavailable. */
	private refused(token: CheckpointToken, lane: SessionAcceptanceLane, cause: unknown): RecoveryOutcome<never> {
		const stale = this.staleness(token, lane);
		if (stale) return this.refuse(stale);
		if (cause instanceof RecoveryRefusedError) return this.refuse(cause.failure);
		if (cause instanceof CompactReadError)
			return this.refuse(cause.reason === "released" ? repairNeeded("released") : storageUnavailable(cause.reason));
		throw cause;
	}

	/** Every typed failure leaves through here, counted by its reason; a storage refusal also by its detail. */
	private refuse(failure: RecoveryFailure): RecoveryOutcome<never> {
		const reason = refusalReason(failure);
		this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
		if (failure.kind === "storage_unavailable")
			this.unavailable.set(failure.reason, (this.unavailable.get(failure.reason) ?? 0) + 1);
		return { ok: false, failure };
	}
}
