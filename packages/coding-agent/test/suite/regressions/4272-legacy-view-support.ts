import type { RecoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import type { CanonicalRecord } from "../../../src/modes/rpc/compact-lane-transitions.ts";
import type { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import type { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

export const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

/** The legacy wire shape of an indexed assistant update (`toJsonEvent`: usage and the event without its partial). */
export const update = (assistantMessageEvent: object, outer: object = {}) => ({
	type: "message_update",
	usage,
	assistantMessageEvent,
	...outer,
});

/** A registered peer whose transport the test can hold (backpressure) and release; its written lines in order. */
export interface HeldPeer {
	readonly lines: string[];
	hold(): void;
	release(): void;
}

export function heldPeer(writer: SessionEventWriter, id: string, capabilities: readonly string[] = []): HeldPeer {
	const lines: string[] = [];
	let blocked = false;
	const waiters: (() => void)[] = [];
	writer.registerConnection(
		id,
		{
			writeRaw: (chunk) => void lines.push(chunk),
			waitForBackpressure: () =>
				blocked ? new Promise<void>((resolve) => void waiters.push(resolve)) : Promise.resolve(),
		},
		{ maxQueueBytes: 600 },
	);
	if (capabilities.length > 0) writer.setConnectionCapabilities(id, capabilities);
	return {
		lines,
		hold: () => {
			blocked = true;
		},
		release: () => {
			blocked = false;
			for (const resolve of waiters.splice(0)) resolve();
		},
	};
}

/**
 * Drives one acceptance lane the way the in-process binding does (S03b-3a, one acceptance unit): the lane accepts
 * the legacy record with its canonical half, then the writer enqueues the unchanged legacy record. A message start
 * mints the message identity; every later record of that message carries it with its own producer ordinal.
 */
export class LaneProducer {
	private ordinal = 0;
	private first = 0;
	private carrier: RecoveryCarrier | undefined;
	private readonly writer: SessionEventWriter;
	private readonly lane: SessionAcceptanceLane;
	private readonly sessionId: string;

	constructor(writer: SessionEventWriter, lane: SessionAcceptanceLane, sessionId: string) {
		this.writer = writer;
		this.lane = lane;
		this.sessionId = sessionId;
	}

	record(record: object): void {
		this.lane.accept(record, undefined);
		this.writer.enqueue(this.sessionId, record);
	}

	/** An assistant stream record and the seeded canonical record the structured lane projects for it. */
	assistant(legacy: { readonly type: string; readonly [key: string]: unknown }, canonical: object): void {
		const ordinal = ++this.ordinal;
		if (legacy.type === "message_start" || this.carrier === undefined) {
			this.carrier = { messageId: `message-${ordinal}`, epoch: this.lane.recoveryEpoch };
			this.first = ordinal;
		}
		const carrier = this.carrier;
		this.lane.accept(legacy, carrier, {
			record: canonical as CanonicalRecord,
			carrier,
			ordinal,
			firstOrdinal: this.first,
		});
		this.writer.enqueue(this.sessionId, legacy);
		if (legacy.type === "message_end") this.carrier = undefined;
	}

	blockStart(kind: "text" | "thinking", contentIndex: number): void {
		const block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
		this.assistant(
			update({ type: `${kind}_start`, contentIndex }),
			update({ type: `${kind}_start`, contentIndex, seed: { block, coveredCodeUnits: 0, nextOffset: 0 } }),
		);
	}

	blockDelta(kind: "text" | "thinking", contentIndex: number, delta: string, offset: number): void {
		this.assistant(
			update({ type: `${kind}_delta`, contentIndex, delta }),
			update({ type: `${kind}_delta`, contentIndex, delta, offset }),
		);
	}

	blockEnd(kind: "text" | "thinking", contentIndex: number, content: string): void {
		const block = kind === "text" ? { type: "text", text: content } : { type: "thinking", thinking: content };
		this.assistant(
			update({ type: `${kind}_end`, contentIndex, content }),
			update({ type: `${kind}_end`, contentIndex, content, block }),
		);
	}
}
