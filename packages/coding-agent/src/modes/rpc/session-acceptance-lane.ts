import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import { AcceptedTranscript, type TranscriptRoot } from "./accepted-transcript.ts";
import { correlatedRecord } from "./client-message-events.ts";
import { CompactSettledMessages, type SettledDiagnostic, type SettledRoot } from "./compact-settled-messages.ts";
import type { CompactContentStoreOptions } from "./compact-content-store.ts";

/** Where one accepted recovery record sits in its runtime incarnation (R3.C1.1). */
interface AcceptedRef {
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly historyVersion: number;
	readonly messageId: string | null;
	readonly turnId: string | null;
}

interface AcceptedCorrelation {
	readonly sequence: number;
	readonly clientMessageId: unknown;
	readonly clientTurnId: unknown;
	readonly clientMessages: unknown;
}

export interface FrozenAcceptedRoot {
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly activeMessageId: string | null;
	readonly turnId: string | null;
	readonly correlation: AcceptedCorrelation | null;
	readonly transcript: TranscriptRoot;
	readonly settled: SettledRoot;
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
]);

function field(record: object, key: string): unknown {
	return key in record ? Reflect.get(record, key) : undefined;
}

function turnScoped(type: string, record: object): boolean {
	if (type === "turn_end" || type.startsWith("tool_execution_")) return true;
	if (!type.startsWith("message_")) return false;
	const role = field(Object(field(record, "message")), "role");
	return role === "assistant" || role === "toolResult";
}

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
	private nonce: string = randomUUID();
	private settled!: CompactSettledMessages;
	private readonly rootOwners = new WeakMap<FrozenAcceptedRoot, CompactSettledMessages>();
	private cleanup: Promise<void> = Promise.resolve();
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

	get retired(): boolean {
		return this.retiredAs !== undefined;
	}

	get liveRoots(): number {
		return this.live.size;
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
			if (transition.kind === "append" && this.transcript.available) this.settled.append(transition);
		}
	}

	accept(record: object, carrier: RecoveryCarrier | undefined): AcceptedRef | undefined {
		const type = field(record, "type");
		if (this.retired || this.epoch === "" || typeof type !== "string" || !SEQUENCED.has(type)) return undefined;
		this.acceptCorrelation(record);
		this.sequence += 1;
		if (type === "turn_start" || (this.turnId === null && turnScoped(type, record))) this.turnId = randomUUID();
		const turnId = this.turnId;
		if (type === "turn_end" || type === "agent_end") this.turnId = null;
		const messageId = type.startsWith("message_") && this.settled.valid(carrier) ? carrier.messageId : null;
		if (type === "message_start") this.activeMessageId = messageId;
		if (type === "message_end") this.settled.end(record, carrier, this.sequence, turnId);
		if (type === "transcript_write_failed") this.settled.fail(carrier, String(field(record, "errorMessage")));
		if (type === "message_end" && this.activeMessageId === messageId) this.activeMessageId = null;
		return {
			sessionEpoch: this.epoch,
			sequence: this.sequence,
			historyVersion: this.transcript.historyVersion,
			messageId,
			turnId,
		};
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
		});
		if (this.retired) return root;
		this.rootOwners.set(root, this.settled);
		this.live.add(root);
		return root;
	}

	release(root: FrozenAcceptedRoot): void {
		if (this.live.delete(root)) this.rootOwners.get(root)?.release(root.settled);
	}

	readSettled(root: FrozenAcceptedRoot) {
		const owner = this.rootOwners.get(root);
		if (this.retired || !owner || !this.live.has(root)) throw new Error("accepted root released");
		return owner.read(root.settled);
	}

	storageStatus() {
		return this.settled.storageStatus();
	}

	async idle(): Promise<void> {
		await this.cleanup;
		await this.settled.idle();
	}

	private retireSettled(): void {
		for (const root of this.live) this.release(root);
		this.cleanup = Promise.all([this.cleanup, this.settled.retire()]).then(() => {});
		void this.cleanup.catch(() => this.diagnose("retired_owner"));
	}

	/** No record is accepted after retirement, and every root this lane published is released. */
	retire(reason: "close" | "worker_failed"): void {
		this.retiredAs ??= reason;
		if (this.settled) this.retireSettled();
	}

	/** A change of the outer client correlation is its own transition, sequenced just before its record (C1.1). */
	private acceptCorrelation(record: object): void {
		// Within a turn, any identity-less correlated record other than turn_start (user input, an extension steer, a
		// mid-turn session_abort, custom-role message_* records) keeps the standing correlation and gains no client identity
		// of its own; only a new turn boundary ends it (ruling B).
		const identified = "clientMessageId" in record || "clientTurnId" in record;
		if (!identified && (this.correlation === null || !correlatedRecord(record))) return;
		if (!identified && this.turnId !== null && field(record, "type") !== "turn_start") return;
		const next = {
			clientMessageId: field(record, "clientMessageId"),
			clientTurnId: field(record, "clientTurnId"),
			clientMessages: field(record, "clientMessages"),
		};
		const current = this.correlation;
		const currentMessages = current?.clientMessages;
		const nextMessages = next.clientMessages;
		if (
			current !== null &&
			current.clientMessageId === next.clientMessageId &&
			current.clientTurnId === next.clientTurnId &&
			(currentMessages === nextMessages ||
				(Array.isArray(currentMessages) &&
					Array.isArray(nextMessages) &&
					currentMessages.length === nextMessages.length &&
					currentMessages.every(
						(identity: unknown, index: number) =>
							field(Object(identity), "clientMessageId") ===
								field(Object(nextMessages[index]), "clientMessageId") &&
							field(Object(identity), "clientTurnId") === field(Object(nextMessages[index]), "clientTurnId"),
					)))
		)
			return;
		this.sequence += 1;
		this.correlation = Object.freeze({ sequence: this.sequence, ...next });
	}
}
