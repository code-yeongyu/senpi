import { classifyPoolFailure, type PoolFailureClassification } from "./classify.ts";
import type { SelectableSlot } from "./select.ts";

/** Must stay byte-identical to the claude-sdk-oauth marker AgentSession already honors. */
export const TURN_RETRY_SUPPRESSION_PREFIX = "senpi:no-turn-retry:";
export const DEFAULT_SLOT_BLOCK_MS = 60_000;
export const MAX_SLOT_BLOCK_MS = 48 * 60 * 60 * 1_000;

export type PoolFailoverEvent<TSlot extends SelectableSlot> = {
	slot: TSlot;
	nextSlot?: TSlot;
	classification: PoolFailureClassification;
	attempt: number;
	committedOutput: boolean;
};

export type PoolFailoverOptions<TEvent, TSlot extends SelectableSlot> = {
	slots: readonly TSlot[];
	select: (slots: readonly TSlot[]) => TSlot;
	runAttempt: (slot: TSlot) => AsyncIterable<TEvent> | Promise<AsyncIterable<TEvent>>;
	classify?: (error: unknown) => PoolFailureClassification;
	/**
	 * Rotation is transparent only before committed output. Absent, every yielded
	 * event counts as committed (default-DENY), so silent mid-stream rotation
	 * requires an explicit opt-in from a caller that knows which events are
	 * bookkeeping rather than user-visible output.
	 */
	isCommittedOutput?: (event: TEvent) => boolean;
	persistBlock?: (slot: TSlot) => void | Promise<void>;
	onRotate?: (event: PoolFailoverEvent<TSlot>) => void | Promise<void>;
	now?: () => number;
	baseBlockMs?: number;
};

export class PoolFailoverError extends Error {
	readonly classification: PoolFailureClassification;
	readonly original: unknown;
	readonly suppressTurnRetry: boolean;

	constructor(classification: PoolFailureClassification, original: unknown, suppressTurnRetry: boolean) {
		const detail = original instanceof Error ? original.message : String(original);
		super(`${suppressTurnRetry ? TURN_RETRY_SUPPRESSION_PREFIX : ""}${detail}`);
		this.name = "PoolFailoverError";
		this.classification = classification;
		this.original = original;
		this.suppressTurnRetry = suppressTurnRetry;
	}
}

function blockedSlot<TSlot extends SelectableSlot>(
	slot: TSlot,
	classification: PoolFailureClassification,
	now: number,
	attempt: number,
	baseBlockMs: number,
): TSlot {
	if (classification.blockReason === "auth_error") {
		// An auth block has no expiry: only a re-login rewrites the slot.
		const next = { ...slot, blockReason: "auth_error" };
		delete next.blockedUntil;
		return next;
	}
	const fallback = Math.min(MAX_SLOT_BLOCK_MS, baseBlockMs * 2 ** attempt);
	const duration = Math.min(MAX_SLOT_BLOCK_MS, classification.retryAfterMs ?? fallback);
	return { ...slot, blockedUntil: now + duration, blockReason: "rate_limit" };
}

/**
 * Runs at most one attempt per slot. A rotation is transparent only while no
 * committed output has reached the caller; afterwards the classified error is
 * thrown with the turn-retry suppression marker so the session layer never
 * replays a partially delivered turn. Non-rotate classes throw immediately and
 * compose with the retry/model-fallback machinery above this engine.
 */
export async function* runSlotFailover<TEvent, TSlot extends SelectableSlot>(
	options: PoolFailoverOptions<TEvent, TSlot>,
): AsyncGenerator<TEvent> {
	const now = options.now ?? Date.now;
	const classify = options.classify ?? classifyPoolFailure;
	const committed = options.isCommittedOutput ?? (() => true);
	const baseBlockMs = options.baseBlockMs ?? DEFAULT_SLOT_BLOCK_MS;
	let slots = [...options.slots];
	let lastError: PoolFailoverError | undefined;

	for (let attempt = 0; attempt < options.slots.length; attempt++) {
		const slot = options.select(slots);
		let committedOutput = false;
		try {
			const attemptStream = await options.runAttempt(slot);
			for await (const event of attemptStream) {
				committedOutput ||= committed(event);
				yield event;
			}
			return;
		} catch (error) {
			const classification = classify(error);
			const failure = new PoolFailoverError(classification, error, committedOutput);
			lastError = failure;
			if (classification.action !== "rotate") throw failure;

			const blocked = blockedSlot(slot, classification, now(), attempt, baseBlockMs);
			slots = slots.map((candidate) => (candidate.name === blocked.name ? blocked : candidate));
			await options.persistBlock?.(blocked);
			const rotation: PoolFailoverEvent<TSlot> = {
				slot: blocked,
				classification,
				attempt: attempt + 1,
				committedOutput,
			};
			try {
				if (!committedOutput && attempt + 1 < slots.length) {
					rotation.nextSlot = options.select(slots);
				}
			} finally {
				await options.onRotate?.(rotation);
			}
			if (committedOutput) throw failure;
		}
	}
	throw lastError ?? new Error("Credential pool failover exhausted without an attempt");
}
