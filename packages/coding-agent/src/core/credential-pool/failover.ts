import { TURN_RETRY_SUPPRESSION_PREFIX } from "@earendil-works/pi-ai/auth/pool/failover";
import { attachProviderDiagnostic } from "@earendil-works/pi-ai/utils/provider-diagnostic-carrier";
import { credentialPoolBlockedDiagnostic } from "@earendil-works/pi-ai/utils/provider-diagnostic-vocabulary";
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
	/**
	 * Marks the terminal event forwarded when every slot is limited, with the time the first one is due
	 * back, so the session and goal read a rate limit with its reset instead of one slot's bare error
	 * (senpi#3975).
	 */
	withPoolRetryAt?: (event: TEvent, retryAt: number) => TEvent;
	/**
	 * Called once when the request leaves a selected slot without a verdict on it: neither a success
	 * nor a persisted block (an abort, a request-scoped failure, exhausted same-slot retries, or the
	 * caller stopping the stream). A lane hands back what it reserved for the attempt, such as a
	 * half-open probe lease, so the slot is not stranded until that reservation expires (senpi#4094).
	 */
	releaseSlot?: (slot: TSlot) => void | Promise<void>;
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
 * A slot's due-back time as the reader's local clock shows it, followed by the ISO instant that the goal
 * provider-retry scan (`providerRetryAt`) and turn-end liveness read from this text (senpi#4329).
 */
function dueBack(epochMs: number): string {
	return `${localTime(epochMs)} (${new Date(epochMs).toISOString()})`;
}

function localTime(epochMs: number): string {
	return new Date(epochMs).toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
}

/**
 * Why the request had nowhere to go: each slot it could not use, with its reason and the time it is
 * due back, so a refusal is never a bare "no slots" that only a re-login seemed to fix (senpi#2081).
 * It ends with the one step that works: wait for the first slot due back, or reconnect when none is
 * due back on its own (senpi#4329).
 */
function noSlotsMessage(slots: readonly RunSlot[], now: number): string {
	const blocked = slots.map((slot) => {
		const reason = slot.blockReason ?? "blocked";
		if (slot.blockedUntil !== undefined && slot.blockedUntil > now) {
			return `${slot.name} (${reason} until ${dueBack(slot.blockedUntil)})`;
		}
		return reason === "account_disabled"
			? `${slot.name} (account_disabled until re-login)`
			: `${slot.name} (${reason})`;
	});
	const firstBack = soonestRetryAt(slots, now);
	const step =
		firstBack === undefined
			? "Sign in again or add a new API key for this provider, or choose another model."
			: `Wait until ${localTime(firstBack)}, or choose another model.`;
	return blocked.length === 0
		? `No credential slots available. ${step}`
		: `No credential slots available: ${blocked.join(", ")}. ${step}`;
}

function isRateLimitBlock(action: CredentialAction): boolean {
	return action.kind === "failover" && action.block.reason === "rate_limit";
}

/** The soonest due-back time when a rate or usage limit is among the blocks, else undefined. */
function limitedUntil(slots: readonly RunSlot[], now: number): number | undefined {
	const limited = slots.some(
		(slot) => slot.blockReason === "rate_limit" && slot.blockedUntil !== undefined && slot.blockedUntil > now,
	);
	return limited ? soonestRetryAt(slots, now) : undefined;
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
	// The slot this request selected and has not yet settled with a success or a persisted block.
	let unsettled: TSlot | undefined;

	try {
		while (true) {
			const slots = await options.listSlots();
			const available = slots.filter((slot) => !attempted.has(slot.name) && isAvailable(slot, now()));
			const candidates = available.length > 0 ? available : coolingProbe(slots, attempted);
			if (candidates.length === 0) {
				// Only a refusal that is itself a limit is the pool's rate limit: a probe refused for auth, billing
				// or a missing model keeps its own classification, which the goal's auth block reads (senpi#3975).
				const limitedRetryAt =
					lastError === undefined || isRateLimitBlock(lastError.action) ? limitedUntil(slots, now()) : undefined;
				if (lastTerminalEvent !== undefined) {
					yield limitedRetryAt === undefined || options.withPoolRetryAt === undefined
						? lastTerminalEvent
						: options.withPoolRetryAt(lastTerminalEvent, limitedRetryAt);
					return;
				}
				const retryAt = soonestRetryAt(slots, now());
				const refusal =
					lastError !== undefined && lastOriginal !== undefined
						? new CredentialFailoverError(lastError.action, lastOriginal, retryAt === undefined ? {} : { retryAt })
						: new CredentialFailoverError(
								{ kind: "fail_request" },
								new Error(noSlotsMessage(slots, now())),
								retryAt === undefined ? {} : { retryAt },
							);
				throw limitedRetryAt === undefined
					? refusal
					: attachProviderDiagnostic(refusal, credentialPoolBlockedDiagnostic(limitedRetryAt));
			}
			const slot = options.select(candidates);
			unsettled = slot;
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
				unsettled = undefined;
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
					if (used < action.maxAttempts) {
						// Hand back what the attempt reserved before listing again: the next pass takes its own
						// reservation, and a lease kept here would list this slot as another request's probe.
						unsettled = undefined;
						await options.releaseSlot?.(slot);
						continue;
					}
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

				unsettled = undefined;
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
	} finally {
		if (unsettled !== undefined) await options.releaseSlot?.(unsettled);
	}
}
