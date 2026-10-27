import { randomUUID } from "node:crypto";
import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import { AcceptedTranscript, type TranscriptRoot } from "./accepted-transcript.ts";
import { correlatedRecord } from "./client-message-events.ts";

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
}

/** The incarnation's transcript as its manager journaled it up to bootstrap: base, unpersisted entries, leaf. */
export interface SessionBootstrap {
	readonly transcript: readonly TranscriptTransition[];
}

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

	get retired(): boolean {
		return this.retiredAs !== undefined;
	}

	get liveRoots(): number {
		return this.live.size;
	}

	bootstrap(input: SessionBootstrap): void {
		if (this.retired) return;
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
		const messageId = type.startsWith("message_") ? (carrier?.messageId ?? null) : null;
		if (type === "message_start") this.activeMessageId = messageId;
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
		});
		this.live.add(root);
		return root;
	}

	release(root: FrozenAcceptedRoot): void {
		this.live.delete(root);
	}

	/** No record is accepted after retirement, and every root this lane published is released. */
	retire(reason: "close" | "worker_failed"): void {
		this.retiredAs ??= reason;
		this.live.clear();
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
