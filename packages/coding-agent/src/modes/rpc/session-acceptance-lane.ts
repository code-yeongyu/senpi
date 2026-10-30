import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import { AcceptedTranscript, type TranscriptRoot } from "./accepted-transcript.ts";
import { CALL_RECORDS } from "./compact-call-model.ts";
import { COMPONENT_RECORDS } from "./compact-current-components.ts";
import { CompactLaneCurrent } from "./compact-lane-current.ts";
import type { CanonicalUnit } from "./compact-lane-transitions.ts";
import { CompactSettledMessages, type SettledDiagnostic, type SettledRoot } from "./compact-settled-messages.ts";
import type { FrozenCompactState } from "./compact-state-view.ts";
import type { CompactContentStoreOptions } from "./compact-content-store.ts";
import { type AcceptedCorrelation, admitRecord, correlationChange, field } from "./session-acceptance-admission.ts";
import { foldCompactRecord, foldCompactTransition } from "./session-acceptance-compact.ts";

/** Where one accepted recovery record sits in its runtime incarnation (R3.C1.1). */
interface AcceptedRef {
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly historyVersion: number;
	readonly messageId: string | null;
	readonly turnId: string | null;
}

export interface FrozenAcceptedRoot {
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly activeMessageId: string | null;
	readonly turnId: string | null;
	readonly correlation: AcceptedCorrelation | null;
	readonly transcript: TranscriptRoot;
	readonly settled: SettledRoot;
	/** The compact current state at this root's sequence; absent once that component became unavailable. */
	readonly current: FrozenCompactState | undefined;
}

/** The incarnation's transcript as its manager journaled it up to bootstrap: base, unpersisted entries, leaf. */
export interface SessionBootstrap {
	readonly transcript: readonly TranscriptTransition[];
	/** Replacement handshake: the host fills this nonce before returning the worker's output credit. */
	readonly epochSignal?: SharedArrayBuffer;
}

const RETIRED_SETTLED: SettledRoot = Object.freeze({ base: undefined, overrides: undefined });

/** Recovery kinds take a sequence; responses and every other record keep FIFO order with none. */
const SEQUENCED = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"entry_appended",
	"session_abort",
	"transcript_write_failed",
	...COMPONENT_RECORDS,
	...CALL_RECORDS,
]);

/**
 * The ordered acceptance lane of one routing session. Every record reaches it synchronously, before
 * `SessionEventWriter.enqueue`, in the order the session produced it; a worker's records arrive here before
 * the worker's credit returns. Each bootstrap starts a new `sessionEpoch` whose sequences are never compared
 * with another epoch's.
 */
export class SessionAcceptanceLane {
	private epoch = "";
	private sequence = 0;
	private transcript = new AcceptedTranscript();
	private activeMessageId: string | null = null;
	private turnId: string | null = null;
	private correlation: AcceptedCorrelation | null = null;
	private readonly live = new Set<FrozenAcceptedRoot>();
	private retiredAs: "close" | "worker_failed" | undefined;
	private storageRetired = false;
	private nonce: string = randomUUID();
	private settled!: CompactSettledMessages;
	private readonly rootOwners = new WeakMap<FrozenAcceptedRoot, CompactSettledMessages>();
	private cleanup: Promise<void> = Promise.resolve();
	private readonly current = new CompactLaneCurrent();
	private readonly storage: CompactContentStoreOptions | undefined;
	private readonly diagnose: (reason: SettledDiagnostic) => void;

	constructor(
		storage?: CompactContentStoreOptions,
		diagnose: (reason: SettledDiagnostic) => void = (reason) =>
			process.stderr.write(`senpi rpc acceptance: settled transition: ${reason}\n`),
	) {
		this.storage = storage;
		this.diagnose = diagnose;
	}

	get recoveryEpoch(): string {
		return this.nonce;
	}

	/** The public epoch of this incarnation (S08-Q1): distinct from the producer nonce, which is never serialized. */
	get sessionEpoch(): string {
		return this.epoch;
	}

	get retired(): boolean {
		return this.retiredAs !== undefined;
	}

	get liveRoots(): number {
		return this.live.size;
	}

	/** Open broadcast questions now (a hot count for status); undefined when the compact state is unavailable. */
	get openBroadcastDialogs(): number | undefined {
		return this.retired ? undefined : this.current.openBroadcastDialogs;
	}

	bootstrap(input: SessionBootstrap, nonce: string = randomUUID()): void {
		if (this.retired) return;
		if (this.settled) this.retireSettled();
		this.nonce = nonce;
		if (input.epochSignal) Buffer.from(nonce, "ascii").copy(Buffer.from(input.epochSignal));
		this.settled = new CompactSettledMessages(
			nonce,
			{
				...this.storage,
				dir: join(this.storage?.dir ?? tmpdir(), `senpi-settled-${randomUUID()}`),
			},
			this.diagnose,
		);
		this.epoch = randomUUID();
		this.current.bootstrap({
			...this.storage,
			dir: join(this.storage?.dir ?? tmpdir(), `senpi-current-${randomUUID()}`),
			epoch: nonce,
			sessionEpoch: this.epoch,
		});
		this.sequence = 0;
		this.transcript = new AcceptedTranscript();
		for (const transition of input.transcript) this.transcript.apply(transition);
		this.activeMessageId = null;
		this.turnId = null;
		this.correlation = null;
	}

	/** Transcript transitions committed before the record they arrive with; each takes its own sequence (C1.1). */
	applyTranscript(transitions: readonly TranscriptTransition[]): void {
		if (this.retired || this.epoch === "") return;
		for (const transition of transitions) {
			this.sequence += 1;
			this.transcript.apply(transition);
			foldCompactTransition(this.compact(), transition, this.transcript.available, this.nonce);
		}
	}

	/** A legacy record and, when the structured lane projected one, its canonical record: one unit, one sequence. */
	accept(record: object, carrier: RecoveryCarrier | undefined, canonical?: CanonicalUnit): AcceptedRef | undefined {
		const type = field(record, "type");
		if (this.retired || this.epoch === "" || typeof type !== "string" || !SEQUENCED.has(type)) return undefined;
		// The calls component decides first, before the lane commits anything for this record, its correlation change
		// included (RULING-13 Q9); a correlation change takes the sequence just before its record.
		const correlation = correlationChange(this.correlation, this.turnId, record);
		const at = { sequence: this.sequence + (correlation ? 1 : 0), turnId: this.turnId };
		const place = admitRecord(this.current, record, type, at);
		if (!place) return undefined;
		if (correlation) this.correlation = Object.freeze({ sequence: place.sequence - 1, ...correlation });
		const { turnId, call } = place;
		this.turnId = turnId;
		this.sequence = place.sequence;
		if (type === "turn_end" || type === "agent_end") this.turnId = null;
		const messageId = type.startsWith("message_") && this.settled.valid(carrier) ? carrier.messageId : null;
		if (type === "message_start") this.activeMessageId = messageId;
		foldCompactRecord(this.compact(), {
			record,
			type,
			carrier,
			canonical,
			sequence: this.sequence,
			turnId,
			call: call?.projection,
		});
		if (type === "message_end" && this.activeMessageId === messageId) this.activeMessageId = null;
		return {
			sessionEpoch: this.epoch,
			sequence: this.sequence,
			historyVersion: this.transcript.historyVersion,
			messageId,
			turnId,
		};
	}

	/** A block control has no legacy record; it is a unit of its own at the next sequence. */
	acceptControl(unit: CanonicalUnit | undefined): number | undefined {
		if (this.retired || this.epoch === "" || !unit) return undefined;
		this.sequence += 1;
		this.current.fold(unit, this.sequence);
		return this.sequence;
	}

	/** A canonical record of this epoch was lost before folding, so its compact state can no longer be complete. */
	compactUnavailable(cause: unknown): void {
		if (!this.retired) this.current.fail(cause);
	}

	freeze(): FrozenAcceptedRoot {
		const root: FrozenAcceptedRoot = Object.freeze({
			sessionEpoch: this.epoch,
			sequence: this.sequence,
			activeMessageId: this.activeMessageId,
			turnId: this.turnId,
			correlation: this.correlation,
			transcript: this.transcript.freeze(),
			// A retired lane's paged settled store refuses new cuts; its root is never live or readable.
			settled: this.retired ? RETIRED_SETTLED : this.settled.freeze(),
			current: this.retired ? undefined : this.current.freeze(),
		});
		if (this.retired) return root;
		this.rootOwners.set(root, this.settled);
		this.live.add(root);
		return root;
	}

	release(root: FrozenAcceptedRoot): void {
		if (!this.live.delete(root)) return;
		this.rootOwners.get(root)?.release(root.settled);
		this.current.release(root.current);
		if (this.retired) this.retireStorage();
	}

	/** True while `root` is readable: published by this lane and not released, by its holder or a retirement. */
	holds(root: FrozenAcceptedRoot): boolean {
		return this.live.has(root);
	}

	readCurrent(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.read(root.current);
	}

	readCurrentComponents(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.readComponents(root.current);
	}

	readCurrentActive(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.readActive(root.current);
	}

	readCurrentCalls(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.readCalls(root.current);
	}

	readSettled(root: FrozenAcceptedRoot) {
		const owner = this.rootOwners.get(root);
		if (!owner || !this.live.has(root)) throw new Error("accepted root released");
		return owner.read(root.settled);
	}

	storageStatus() {
		return this.settled.storageStatus();
	}

	private compact = () => ({ settled: this.settled, current: this.current });

	async idle(): Promise<void> {
		await this.cleanup;
		await this.settled.idle();
		await this.current.idle();
	}

	private retireSettled(): void {
		for (const root of this.live) this.release(root);
		this.cleanup = Promise.all([this.cleanup, this.settled.retire()]).then(() => {});
		void this.cleanup.catch(() => this.diagnose("retired_owner"));
	}

	/**
	 * No record is accepted after retirement, and every root this lane published is released except those in `keep`:
	 * a legacy view still queued at a seal reads its root to the end (RULING-51 Q2=A), and the lane's storage retires
	 * with the last such release. A root never published by this lane is not kept.
	 */
	retire(reason: "close" | "worker_failed", keep: ReadonlySet<FrozenAcceptedRoot> = new Set()): void {
		this.retiredAs ??= reason;
		for (const root of this.live) if (!keep.has(root)) this.release(root);
		this.retireStorage();
	}

	private retireStorage(): void {
		if (this.storageRetired || this.live.size > 0) return;
		this.storageRetired = true;
		if (this.settled) this.retireSettled();
		this.current.retire();
	}
}
