import { TURN_RETRY_SUPPRESSION_PREFIX } from "@earendil-works/pi-ai/auth/pool/failover";
import { type CredentialAction, type CredentialBlock, classifyCredentialFailure } from "./classify.ts";

/**
 * Re-exported for the lanes that still recognize the marker (the Claude SDK
 * lane stamps it because tools execute mid-stream there). The generic pool
 * below never stamps it: see {@link runCredentialFailover}.
 */
export { TURN_RETRY_SUPPRESSION_PREFIX };

export type RunSlot = {
	name: string;
	blockedUntil?: number;
	blockReason?: string;
	failureCount?: number;
	lease?: { id: string; expiresAt: number };
	pinned?: boolean;
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
	/**
	 * Identifies the stream-start announcement. Consumers open one message per
	 * start frame, so once a start has reached the caller the engine drops the
	 * start a replacement attempt re-announces; its later frames then update the
	 * message the caller already holds.
	 */
	isStreamStart?: (event: TEvent) => boolean;
	classify?: (
		error: unknown,
		context: { failureCount: number; cooldownBaseMs?: number; cooldownCapMs?: number },
	) => CredentialAction;
	/**
	 * Extracts the failure carried by a terminal error EVENT. When that failure
	 * ends the request, the event itself is forwarded to the caller - partial
	 * content, usage and transport diagnostics intact - instead of a synthesized
	 * error that would erase them.
	 */
	errorFromEvent?: (event: TEvent) => unknown | undefined;
	/** Persisted BEFORE a replacement slot is selected so a crash never forgets a block. */
	persistBlock: (slot: TSlot, block: CredentialBlock) => void | Promise<void>;
	onRotate?: (event: CredentialFailoverEvent<TSlot>) => void | Promise<void>;
	onSuccess?: (slot: TSlot) => void | Promise<void>;
	now?: () => number;
};

/**
 * Thrown when an attempt failed by THROWING (no terminal event to forward) and
 * the pool has nothing left to try. The message is the provider's own text:
 * whole-turn recovery (same-model retry, model fallback) is the session
 * layer's decision, made from that text exactly as it is for a single-key
 * provider.
 */
export class CredentialFailoverError extends Error {
	readonly action: CredentialAction;
	readonly original: unknown;
	readonly retryAt: number | undefined;

	constructor(action: CredentialAction, original: unknown, options: { retryAt?: number } = {}) {
		const detail = original instanceof Error ? original.message : String(original);
		super(detail, { cause: original });
		this.name = "CredentialFailoverError";
		this.action = action;
		this.original = original;
		this.retryAt = options.retryAt;
	}
}

export function isAvailable(slot: Pick<RunSlot, "blockReason" | "blockedUntil">, now: number): boolean {
	if (slot.blockReason === "account_disabled") return false;
	if (slot.blockedUntil !== undefined && slot.blockedUntil > now) return false;
	// A live lease marks the one caller admitted to run the half-open probe.
	// listSlots excludes that lease for later callers; the holder must remain runnable.
	return true;
}

/**
 * When every slot is cooling and this request has tried none, the rate-limited slot due back first
 * still gets the request (senpi#3771). A cooldown only predicts when a limit lifts: the provider can
 * lift it earlier (a usage reset the user redeemed), and refusing locally would fail every turn with
 * no provider answer until the prediction expires, even across a restart. A slot still limited
 * answers at once and is blocked again; one that recovered serves the turn and is cleared.
 */
function coolingProbe<TSlot extends RunSlot>(slots: readonly TSlot[], attempted: ReadonlySet<string>): TSlot[] {
	if (attempted.size > 0) return [];
	const cooling = slots.filter((slot) => slot.blockReason === "rate_limit" && slot.blockedUntil !== undefined);
	const soonest = cooling.reduce<TSlot | undefined>(
		(best, slot) => (best === undefined || (slot.blockedUntil ?? 0) < (best.blockedUntil ?? 0) ? slot : best),
		undefined,
	);
	return soonest === undefined ? [] : [soonest];
}

/**
 * Why the request had nowhere to go: each slot it could not use, with its reason and the time it is
 * due back, so a refusal is never a bare "no slots" that only a re-login seemed to fix (senpi#2081).
 */
function noSlotsMessage(slots: readonly RunSlot[], now: number): string {
	const blocked = slots.map((slot) => {
		const reason = slot.blockReason ?? "blocked";
		if (slot.blockedUntil !== undefined && slot.blockedUntil > now) {
			return `${slot.name} (${reason} until ${new Date(slot.blockedUntil).toISOString()})`;
		}
		return reason === "account_disabled"
			? `${slot.name} (account_disabled until re-login)`
			: `${slot.name} (${reason})`;
	});
	return blocked.length === 0
		? "No credential slots available"
		: `No credential slots available: ${blocked.join(", ")}`;
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
 * output has reached the caller.
 *
 * The engine guards ONE thing: the integrity of the single event stream the
 * caller consumes. Two attempts may never interleave inside it, so once a
 * delta has been delivered no replacement attempt starts. It does NOT decide
 * whether the turn may be replayed: after committed output the provider's own
 * terminal event is forwarded unchanged, and the session layer treats it like
 * any other mid-stream provider failure (a stall, a reset) - retire the
 * partial, retry or fall back within its budgets. In the plain streaming lanes
 * no tool runs before the message completes, so nothing here needs the
 * `senpi:no-turn-retry:` marker; the Claude SDK lane keeps its own.
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
	let lastTerminalEvent: TEvent | undefined;
	let startAnnounced = false;

	while (true) {
		const slots = await options.listSlots();
		const available = slots.filter((slot) => !attempted.has(slot.name) && isAvailable(slot, now()));
		const candidates = available.length > 0 ? available : coolingProbe(slots, attempted);
		if (candidates.length === 0) {
			if (lastTerminalEvent !== undefined) {
				yield lastTerminalEvent;
				return;
			}
			const retryAt = soonestRetryAt(slots, now());
			throw lastError !== undefined && lastOriginal !== undefined
				? new CredentialFailoverError(lastError.action, lastOriginal, retryAt === undefined ? {} : { retryAt })
				: new CredentialFailoverError(
						{ kind: "fail_request" },
						new Error(noSlotsMessage(slots, now())),
						retryAt === undefined ? {} : { retryAt },
					);
		}
		const slot = options.select(candidates);
		let committedOutput = false;
		let terminalEvent: TEvent | undefined;
		let attemptStream: AsyncIterable<TEvent> | undefined;
		try {
			attemptStream = await options.runAttempt(slot);
			for await (const event of attemptStream) {
				const failure = options.errorFromEvent?.(event);
				if (failure !== undefined) {
					terminalEvent = event;
					throw failure;
				}
				if (options.isStreamStart?.(event)) {
					if (startAnnounced) continue;
					startAnnounced = true;
				}
				committedOutput ||= options.isCommittedOutput(event);
				yield event;
			}
			await options.onSuccess?.(slot);
			return;
		} catch (error) {
			if (attemptStream) await settle(attemptStream);
			const failureCount = (slot.failureCount ?? 0) + (retriesBySlot.get(slot.name) ?? 0);
			const action = classify(error, {
				failureCount,
			});
			lastOriginal = error;
			lastTerminalEvent = terminalEvent;

			if (action.kind === "retry_same" && !committedOutput) {
				const used = (retriesBySlot.get(slot.name) ?? 0) + 1;
				retriesBySlot.set(slot.name, used);
				if (used < action.maxAttempts) continue;
				if (terminalEvent !== undefined) {
					yield terminalEvent;
					return;
				}
				throw new CredentialFailoverError(action, error);
			}
			if (action.kind !== "failover") {
				if (terminalEvent !== undefined) {
					yield terminalEvent;
					return;
				}
				throw new CredentialFailoverError(action, error);
			}

			await options.persistBlock(slot, action.block);
			attempted.add(slot.name);
			const failure = new CredentialFailoverError(action, error);
			lastError = failure;
			await options.onRotate?.({
				slot,
				block: action.block,
				attempt: attempted.size,
				committedOutput,
			});
			if (committedOutput) {
				if (terminalEvent !== undefined) {
					yield terminalEvent;
					return;
				}
				throw failure;
			}
		}
	}
}
