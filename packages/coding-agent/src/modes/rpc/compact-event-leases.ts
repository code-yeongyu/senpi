import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactContentStore, CompactWriteError } from "./compact-content-store.ts";
import { CompactReadError, CompactReadLease } from "./compact-read-lease.ts";
import { FRAGMENT_MAX_BYTES, type FrozenBytes, producePage, type RecoveryPage } from "./compact-recovery-bytes.ts";
import { protocolId } from "./compact-recovery-ids.ts";
import { stageRecord, type RecordContent } from "./compact-record-staging.ts";
export type { RecordContent } from "./compact-record-staging.ts";
import {
	type EventLease,
	type RecoveryCaller,
	type RecoveryOutcome,
	recovered,
	repairNeeded,
	storageUnavailable,
} from "./compact-recovery-types.ts";
import {
	type StagedContent,
	StagedReadError,
	TransferStaging,
	TransferStagingError,
} from "./compact-transfer-staging.ts";

/** F (R4.A3): the largest compact physical record, its newline included; two D-byte fragments. */
export const COMPACT_RECORD_MAX_BYTES = 2 * FRAGMENT_MAX_BYTES;
/** Live event leases one peer incarnation may hold (RULING-65 S13-Q1 (2)); its end frees every one of them. */
const PEER_EVENT_LEASES_MAX = 32;
/** Released lease ids a peer remembers so a retried receipt is a typed `duplicate`, the oldest forgotten first. */
const RELEASED_LEASES_REMEMBERED = 256;
/** The one component an event lease names: the accepted record's exact JSON text. */
const EVENT_RECORD_COMPONENT = "record";

export type EventLeaseRefusal = "lease_limit" | "storage_unavailable";
/** The record's legacy line when a destination already built it, else its stored size to stream it at (RULING-81 X06). */
export type ReleaseOutcome = "released" | "held" | "duplicate";

export interface ReleaseReceipt {
	readonly lease: { readonly kind: "event"; readonly id: string };
	readonly outcome: ReleaseOutcome;
	readonly remaining: number;
}

export interface EventLeaseCounters {
	readonly open: number;
	readonly peers: number;
	readonly minted: number;
	readonly released: number;
	readonly duplicates: number;
	/** Leases whose envelope the socket actor dropped before it reached the peer. */
	readonly abandoned: number;
	/** Stored bytes of accepted records still pinned by a lease. */
	readonly contentBytes: number;
	readonly refused: Readonly<Partial<Record<EventLeaseRefusal, number>>>;
}

/** One accepted record's staged text, shared by every peer's lease on it and released with the last of them. */
interface SharedContent {
	readonly content: StagedContent;
	holders: number;
	opened?: Promise<FrozenBytes>;
}

/** A peer's lease: its sessions scope, the admissions still referencing it and the operation lease its reads run under. */
export interface HeldLease {
	readonly lease: EventLease;
	readonly sessionId: string;
	readonly shared: SharedContent;
	readonly admissions: Set<string>;
	readonly reads: CompactReadLease;
}

interface PeerLeases {
	readonly held: Map<string, HeldLease>;
	/** Released lease id -> its session and the admissions whose receipts released it. */
	readonly released: Map<string, { readonly sessionId: string; readonly admissions: ReadonlySet<string> }>;
}

/**
 * The ordinary-event leases of one host (S13, R4.B6; RULING-65 S13-Q1/Q2 = A). A record past F for a peer that selected
 * compact events is staged once, as its exact JSON text, into this owner's own spillable store and leased to each such
 * peer at the record's accepted sequence. A lease is scoped like a checkpoint token (another peer or session is
 * `unknown_token`, with no state), never mints a generation and holds no lane root, so a checkpoint's lifetime and a
 * superseded root are untouched by it. It is released only by its consumer's receipt, sent after the consumer
 * committed the content (the named commit point: desktop's successful command-transaction dispatch); transport drain,
 * worker credit or staging every page release nothing. Per (peer, lease) the referencing admissions are counted,
 * released at zero, never below; a retried receipt is the typed `duplicate`. A peer's end releases all of its leases.
 */
export class EventLeases {
	readonly peerLimit: number;
	private readonly peers = new Map<string, PeerLeases>();
	private readonly shared = new WeakMap<object, SharedContent>();
	private readonly ended = new Set<(leaseId: string) => void>();
	private readonly refusals = new Map<EventLeaseRefusal, number>();
	private staging: TransferStaging | undefined;
	private open = 0;
	private minted = 0;
	private released = 0;
	private duplicates = 0;
	private abandoned = 0;
	private contentBytes = 0;

	constructor(peerLimit = PEER_EVENT_LEASES_MAX) {
		this.peerLimit = peerLimit;
	}

	/** Runs once per lease when it ends, however it ended (a receipt or its peer's end). */
	onLeaseEnd(listener: (leaseId: string) => void): void {
		this.ended.add(listener);
	}

	/**
	 * A lease for one peer admission on the record `line` serializes (keyed by `record`, so every peer shares one staged
	 * copy), taken synchronously at acceptance: later mutation of the provider object cannot reach the staged text.
	 */
	mint(
		caller: RecoveryCaller & { readonly admissionId: string },
		at: Pick<EventLease, "sessionEpoch" | "sequence">,
		record: object,
		content: RecordContent,
	): { readonly ok: true; readonly value: EventLease } | { readonly ok: false; readonly reason: EventLeaseRefusal } {
		const peer = this.peers.get(caller.socketEpoch) ?? { held: new Map(), released: new Map() };
		if (peer.held.size >= this.peerLimit) return this.refuse("lease_limit");
		const shared = this.stage(record, content);
		if (!shared) return this.refuse("storage_unavailable");
		const { entry } = shared.content.ref;
		const lease: EventLease = Object.freeze({
			kind: "event",
			id: protocolId(`event:${caller.socketEpoch}:${++this.minted}`),
			admissionId: caller.admissionId,
			...at,
			componentRef: EVENT_RECORD_COMPONENT,
			length: entry.length,
			digest: entry.digest,
		});
		shared.holders += 1;
		const held: HeldLease = {
			lease,
			sessionId: caller.sessionId,
			shared,
			admissions: new Set([caller.admissionId]),
			reads: new CompactReadLease(() => this.dispose(peer, held)),
		};
		peer.held.set(lease.id, held);
		this.peers.set(caller.socketEpoch, peer);
		this.open += 1;
		return { ok: true, value: lease };
	}

	/** The caller's own live lease, or `unknown_token` with no state. */
	claim(caller: RecoveryCaller, leaseId: string, admissionId: string): RecoveryOutcome<HeldLease> {
		const held = this.peers.get(caller.socketEpoch)?.held.get(leaseId);
		if (!held || held.sessionId !== caller.sessionId || !held.admissions.has(admissionId))
			return { ok: false, failure: repairNeeded("unknown_token") };
		return recovered(held);
	}

	/** One bounded page of the leased record, its whole digest verified once before any page is served. */
	async page(
		held: HeldLease,
		componentRef: string,
		offset: number,
		signal?: AbortSignal,
	): Promise<RecoveryOutcome<RecoveryPage>> {
		const staging = this.staging;
		if (componentRef !== EVENT_RECORD_COMPONENT || !staging)
			return { ok: false, failure: storageUnavailable("range") };
		try {
			if (staging.store.health.needsRecovery) await staging.store.repair();
			return recovered(
				await held.reads.run(async () => {
					held.shared.opened ??= staging.open(held.shared.content);
					const bytes = await held.shared.opened;
					if (signal?.aborted) throw new CompactReadError("aborted");
					return producePage(bytes, offset, () => held.reads.assert());
				}),
			);
		} catch (cause) {
			held.shared.opened = undefined;
			if (cause instanceof StagedReadError) return { ok: false, failure: storageUnavailable("integrity") };
			if (!(cause instanceof CompactReadError)) throw cause;
			const failure = cause.reason === "released" ? repairNeeded("released") : storageUnavailable(cause.reason);
			return { ok: false, failure };
		}
	}

	/** The consumer's receipt for one admission's reference (RULING-65 S13-Q2): idempotent, identity-bound, never below 0. */
	release(caller: RecoveryCaller, leaseId: string, admissionId: string): RecoveryOutcome<ReleaseReceipt> {
		const peer = this.peers.get(caller.socketEpoch);
		const receipt = (outcome: ReleaseOutcome, remaining: number) =>
			recovered<ReleaseReceipt>({ lease: { kind: "event", id: leaseId }, outcome, remaining });
		if (!peer) return { ok: false, failure: repairNeeded("unknown_token") };
		const held = peer.held.get(leaseId);
		if (held?.sessionId === caller.sessionId && held.admissions.delete(admissionId)) {
			this.remember(peer, held, admissionId);
			if (held.admissions.size > 0) return receipt("held", held.admissions.size);
			this.released += 1;
			held.reads.release();
			return receipt("released", 0);
		}
		const done = peer.released.get(leaseId);
		if (done?.sessionId === caller.sessionId && done.admissions.has(admissionId)) {
			this.duplicates += 1;
			return receipt("duplicate", held?.admissions.size ?? 0);
		}
		return { ok: false, failure: repairNeeded("unknown_token") };
	}

	/**
	 * The envelope naming this lease never reached its peer (superseded, shed or cut by the socket actor, S13a review):
	 * the lease ends with no receipt, at once and only once; an unknown or already ended lease is a no-op.
	 */
	abandon(socketEpoch: string, leaseId: string): void {
		const held = this.peers.get(socketEpoch)?.held.get(leaseId);
		if (!held || !held.reads.release()) return;
		this.abandoned += 1;
	}

	/** A peer incarnation is gone: every lease it holds ends once the reads in flight on it unwind. */
	forgetPeer(socketEpoch: string): void {
		const peer = this.peers.get(socketEpoch);
		this.peers.delete(socketEpoch);
		for (const held of peer?.held.values() ?? []) held.reads.release();
	}

	status(): EventLeaseCounters {
		return {
			open: this.open,
			peers: this.peers.size,
			minted: this.minted,
			released: this.released,
			duplicates: this.duplicates,
			abandoned: this.abandoned,
			contentBytes: this.contentBytes,
			refused: Object.fromEntries(this.refusals),
		};
	}

	/** The record's text staged once and adopted by this owner; undefined when the store could not take it. */
	private stage(record: object, content: RecordContent): SharedContent | undefined {
		const existing = this.shared.get(record);
		if (existing && existing.holders > 0) return existing;
		this.staging ??= new TransferStaging(
			new CompactContentStore({ dir: join(tmpdir(), `senpi-event-leases-${randomUUID()}`) }),
		);
		try {
			const staged = stageRecord(this.staging, record, content);
			this.staging.adopt(staged);
			const shared: SharedContent = { content: staged, holders: 0 };
			this.contentBytes += staged.ref.entry.length;
			this.shared.set(record, shared);
			return shared;
		} catch (cause) {
			if (
				cause instanceof TransferStagingError ||
				cause instanceof CompactWriteError ||
				cause instanceof CompactReadError
			) {
				process.stderr.write(`senpi rpc event lease: record not staged (${cause.message})\n`);
				return undefined;
			}
			throw cause;
		}
	}

	private remember(peer: PeerLeases, held: HeldLease, admissionId: string): void {
		const admissions = new Set([...(peer.released.get(held.lease.id)?.admissions ?? []), admissionId]);
		peer.released.set(held.lease.id, { sessionId: held.sessionId, admissions });
		for (const oldest of peer.released.keys()) {
			if (peer.released.size <= RELEASED_LEASES_REMEMBERED) break;
			peer.released.delete(oldest);
		}
	}

	/** The lease's last operation unwound after its release: its content goes with the last lease sharing it. */
	private dispose(peer: PeerLeases, held: HeldLease): void {
		peer.held.delete(held.lease.id);
		this.open -= 1;
		held.shared.holders -= 1;
		if (held.shared.holders === 0 && this.staging) {
			this.staging.release(held.shared.content);
			this.contentBytes -= held.shared.content.ref.entry.length;
		}
		for (const listener of this.ended) listener(held.lease.id);
	}

	private refuse(reason: EventLeaseRefusal): { readonly ok: false; readonly reason: EventLeaseRefusal } {
		this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
		return { ok: false, reason };
	}
}
