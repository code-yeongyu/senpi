import { FRAGMENT_MAX_BYTES } from "./compact-recovery-bytes.ts";
import { protocolId } from "./compact-recovery-ids.ts";
import {
	type StagedContent,
	type StagingRefusal,
	type TransferStaging,
	TransferStagingError,
} from "./compact-transfer-staging.ts";
import { HostPermits, hostWorkerPermits, type WorkerPermitLedger } from "./session-worker-permits.ts";
import type { SessionWorkerToHost } from "./session-worker-protocol.ts";
import { acknowledge } from "./session-worker-signals.ts";

type Fragment = Extract<SessionWorkerToHost, { type: "fragment" }>;
type StagedTransfer = ReturnType<TransferStaging["begin"]>;

/** Every frame a permit paid for: the payload messages, and the fragments larger ones travel in. */
const PAID = new Set<SessionWorkerToHost["type"]>([
	"ready",
	"snapshot",
	"output",
	"canonical",
	"canonical_unavailable",
	"fragment",
]);
const FRAGMENT_KIND = protocolId("worker_frame");

/**
 * A staging refusal of one worker transfer (RULING-80 (3a)): its cause and the event it carried, the message type and,
 * in the ordered stream, the record's commit-frame ordinal. It fails the whole incarnation, and the host keeps it.
 */
export interface TransferRefusal {
	readonly cause: StagingRefusal | "failed";
	readonly event: { readonly type: string; readonly ordinal?: number; readonly length: number };
}

/**
 * The host half of one worker incarnation's payload transport (S12b): its permits, its one physical ordinal sequence,
 * and the staging of fragments into the lane's S12a store. A fragment is owned once staged, so its permit returns then;
 * the message exists only once its final commit frame arrived and every staged leaf read back verified, and the staged
 * copy is released exactly once either way. Fragment frames never reach acceptance, so they never move the high-water
 * or a first-start binding (RULING-64); the final frame's ordinal is checked with the message it completes.
 */
export class WorkerIntake {
	readonly permits: HostPermits;
	private readonly staging: TransferStaging;
	private readonly fail: (error: string) => void;
	private expected = 0;
	private serial = 0;
	private open: { readonly transfer: StagedTransfer; fed: number } | undefined;
	private refused: TransferRefusal | undefined;

	constructor(
		staging: TransferStaging,
		fail: (error: string) => void,
		ledger: WorkerPermitLedger = hostWorkerPermits,
	) {
		this.staging = staging;
		this.fail = fail;
		this.permits = new HostPermits(ledger);
	}

	/** The physical ordinal this incarnation must send next: a typed diagnostic seam (carry 11). */
	get nextOrdinal(): number {
		return this.expected;
	}

	/** The staging refusal that ended this incarnation, if one did: never a silent worker loss. */
	get refusal(): TransferRefusal | undefined {
		return this.refused;
	}

	received(message: SessionWorkerToHost): void {
		if (PAID.has(message.type)) this.permits.returned();
	}

	/** A gap, duplicate or reordered physical frame is denied and ends this incarnation before any mutation. */
	inOrder(message: { readonly ordinal?: number; readonly signal?: SharedArrayBuffer }): boolean {
		if (message.ordinal === this.expected) {
			this.expected += 1;
			return true;
		}
		if (message.signal) acknowledge(message.signal, false);
		const kind = (message.ordinal ?? Number.POSITIVE_INFINITY) < this.expected ? "duplicate" : "gap";
		this.fail(`session_worker_frame_${kind}`);
		return false;
	}

	/** Stages one fragment; the final one resolves to the whole message, which then takes the ordinary receive path. */
	fragment(frame: Fragment): Promise<SessionWorkerToHost> | undefined {
		const end = frame.offset + frame.text.length * 2;
		const final = end === frame.length;
		if (frame.ordinal !== undefined && !final && !this.inOrder(frame)) return this.refuse(frame);
		const fed = this.open?.fed ?? 0;
		if (frame.offset !== fed)
			return this.refuse(frame, `session_worker_frame_${frame.offset < fed ? "duplicate" : "gap"}`);
		try {
			this.open ??= {
				transfer: this.staging.begin(FRAGMENT_KIND, protocolId(`t${++this.serial}`), frame.length),
				fed,
			};
			this.open.transfer.append(frame.text);
			this.open.fed = end;
		} catch (error) {
			const cause = error instanceof TransferStagingError ? error.reason : "failed";
			const ordinal =
				frame.ordinal === undefined
					? undefined
					: frame.ordinal + Math.ceil((frame.length - frame.offset) / FRAGMENT_MAX_BYTES) - 1;
			this.refused = {
				cause,
				event: { type: frame.of, ...(ordinal === undefined ? {} : { ordinal }), length: frame.length },
			};
			const at = ordinal === undefined ? "" : ` ordinal ${ordinal}`;
			return this.refuse(frame, `session_worker_transfer_${cause}: ${frame.of}${at} (${frame.length} stored bytes)`);
		}
		if (!final) return undefined;
		const content = this.open.transfer.commit();
		this.open = undefined;
		return this.whole(content, frame);
	}

	private refuse(frame: Fragment, error?: string): undefined {
		this.open?.transfer.abort();
		this.open = undefined;
		if (error === undefined) return undefined;
		if (frame.signal) acknowledge(frame.signal, false);
		this.fail(error);
		return undefined;
	}

	private async whole(content: StagedContent, frame: Fragment): Promise<SessionWorkerToHost> {
		try {
			let text = "";
			for await (const chunk of this.staging.chunks(content)) text += chunk;
			const message: SessionWorkerToHost = JSON.parse(text);
			return Object.assign(
				message,
				frame.ordinal === undefined ? {} : { ordinal: frame.ordinal },
				frame.firstOrdinal === undefined ? {} : { firstOrdinal: frame.firstOrdinal },
				frame.signal ? { signal: frame.signal } : {},
				frame.epochSignal && "bootstrap" in message
					? { bootstrap: { ...message.bootstrap, epochSignal: frame.epochSignal } }
					: {},
			);
		} finally {
			this.staging.release(content);
		}
	}
}
