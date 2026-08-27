import { TURN_RETRY_SUPPRESSION_PREFIX } from "@earendil-works/pi-ai/auth/pool/failover";
import { type CredentialAction, type CredentialBlock, classifyCredentialFailure } from "./classify.ts";

export { TURN_RETRY_SUPPRESSION_PREFIX };

export type RunSlot = {
	name: string;
	blockedUntil?: number;
	blockReason?: string;
	failureCount?: number;
};

export type CredentialFailoverEvent<TSlot extends RunSlot> = {
	slot: TSlot;
	block: CredentialBlock;
	attempt: number;
	committedOutput: boolean;
};

export type RunCredentialFailoverOptions<TEvent, TSlot extends RunSlot> = {
	/** Re-read before every distinct-credential attempt so a newly added slot participates. */
	listSlots: () => Promise<readonly TSlot[]> | readonly TSlot[];
	select: (slots: readonly TSlot[]) => TSlot;
	runAttempt: (slot: TSlot) => AsyncIterable<TEvent> | Promise<AsyncIterable<TEvent>>;
	/**
	 * REQUIRED and default-DENY by contract: return false only for event types
	 * explicitly known to be pre-commit bookkeeping. Any event this predicate
	 * does not recognize must count as committed output.
	 */
	isCommittedOutput: (event: TEvent) => boolean;
	classify?: (error: unknown, context: { failureCount: number }) => CredentialAction;
	errorFromEvent?: (event: TEvent) => unknown | undefined;
	/** Persisted BEFORE a replacement slot is selected so a crash never forgets a block. */
	persistBlock: (slot: TSlot, block: CredentialBlock) => void | Promise<void>;
	onRotate?: (event: CredentialFailoverEvent<TSlot>) => void | Promise<void>;
	now?: () => number;
};

export class CredentialFailoverError extends Error {
	readonly action: CredentialAction;
	readonly original: unknown;
	readonly suppressTurnRetry: boolean;
	readonly retryAt: number | undefined;

	constructor(action: CredentialAction, original: unknown, options: { suppressTurnRetry: boolean; retryAt?: number }) {
		const detail = original instanceof Error ? original.message : String(original);
		super(`${options.suppressTurnRetry ? TURN_RETRY_SUPPRESSION_PREFIX : ""}${detail}`, { cause: original });
		this.name = "CredentialFailoverError";
		this.action = action;
		this.original = original;
		this.suppressTurnRetry = options.suppressTurnRetry;
		this.retryAt = options.retryAt;
	}
}

function isAvailable(slot: RunSlot, now: number): boolean {
	if (slot.blockReason === "auth_error" || slot.blockReason === "account_disabled") return false;
	return slot.blockedUntil === undefined || slot.blockedUntil <= now;
}

function soonestRetryAt(slots: readonly RunSlot[], now: number): number | undefined {
	const deadlines = slots
		.map((slot) => slot.blockedUntil)
		.filter((value): value is number => value !== undefined && value > now);
	return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

async function settle<TEvent>(stream: AsyncIterable<TEvent>): Promise<void> {
	// A failed attempt must fully release its transport before a replacement
	// starts, or two live streams can interleave provider-side effects.
	const iterator = stream[Symbol.asyncIterator]();
	try {
		await iterator.return?.(undefined);
	} catch {
		// Settling a dead stream must never mask the original failure.
	}
}

/**
 * Generic in-lane credential failover. Runs at most one failover attempt per
 * slot per request, retries provider-scoped faults on the SAME slot up to the
 * classifier's bound without blocking it, and rotates only while no committed
 * output has reached the caller - afterwards the failure is rethrown with the
 * `senpi:no-turn-retry:` marker so the turn is never replayed.
 */
export async function* runCredentialFailover<TEvent, TSlot extends RunSlot>(
	options: RunCredentialFailoverOptions<TEvent, TSlot>,
): AsyncGenerator<TEvent> {
	const now = options.now ?? Date.now;
	const classify = options.classify ?? classifyCredentialFailure;
	const attempted = new Set<string>();
	const retriesBySlot = new Map<string, number>();
	let lastError: CredentialFailoverError | undefined;
	let lastOriginal: unknown;

	while (true) {
		const slots = await options.listSlots();
		const candidates = slots.filter((slot) => !attempted.has(slot.name) && isAvailable(slot, now()));
		if (candidates.length === 0) {
			const retryAt = soonestRetryAt(slots, now());
			throw lastError !== undefined && lastOriginal !== undefined
				? new CredentialFailoverError(lastError.action, lastOriginal, {
						suppressTurnRetry: lastError.suppressTurnRetry,
						...(retryAt === undefined ? {} : { retryAt }),
					})
				: new CredentialFailoverError({ kind: "fail_request" }, new Error("No credential slots available"), {
						suppressTurnRetry: false,
						...(retryAt === undefined ? {} : { retryAt }),
					});
		}
		const slot = options.select(candidates);
		let committedOutput = false;
		let attemptStream: AsyncIterable<TEvent> | undefined;
		try {
			attemptStream = await options.runAttempt(slot);
			for await (const event of attemptStream) {
				const failure = options.errorFromEvent?.(event);
				if (failure !== undefined) throw failure;
				committedOutput ||= options.isCommittedOutput(event);
				yield event;
			}
			return;
		} catch (error) {
			if (attemptStream) await settle(attemptStream);
			const failureCount = (slot.failureCount ?? 0) + (retriesBySlot.get(slot.name) ?? 0);
			const action = classify(error, { failureCount });
			lastOriginal = error;

			if (action.kind === "retry_same" && !committedOutput) {
				const used = (retriesBySlot.get(slot.name) ?? 0) + 1;
				retriesBySlot.set(slot.name, used);
				if (used < action.maxAttempts) continue;
				throw new CredentialFailoverError(action, error, { suppressTurnRetry: false });
			}
			if (action.kind !== "failover") {
				throw new CredentialFailoverError(action, error, { suppressTurnRetry: committedOutput });
			}

			await options.persistBlock(slot, action.block);
			attempted.add(slot.name);
			const failure = new CredentialFailoverError(action, error, { suppressTurnRetry: committedOutput });
			lastError = failure;
			await options.onRotate?.({ slot, block: action.block, attempt: attempted.size, committedOutput });
			if (committedOutput) throw failure;
		}
	}
}
