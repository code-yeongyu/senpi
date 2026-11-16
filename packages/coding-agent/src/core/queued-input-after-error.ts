import type { Api, Model } from "@earendil-works/pi-ai";
import { type ClientMessageIdentity, clientMessageIdentity } from "./client-message-identity.ts";
import { AccountUsageLimitError } from "./retry-fallback/usage-limit.ts";

/** The provider hold that refuses a queued follow-up after an error run: a spent account or a held model family (senpi#3131). */
export interface QueuedInputHold {
	readonly provider: string;
	/** The user-facing refusal, naming the hold and its reset when the provider stated one. */
	readonly message: string;
	/** Epoch milliseconds the provider said the limit resets; absent when it named none. */
	readonly resetAt?: number;
}

/**
 * A queued follow-up that will not run: a run ended in a provider error under an account hold, so it was taken
 * out of the queue instead of being sent to the held provider (senpi#6868). A sender waiting on it resolves here.
 */
export type QueuedInputFailedEvent = ClientMessageIdentity & {
	readonly type: "queued_input_failed";
	readonly queuedId: string;
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly error: {
		readonly code: "account_usage_limit";
		readonly provider: string;
		readonly message: string;
		readonly resetAt?: number;
	};
};

/** The retry-fallback holds the decision reads (`RetryFallbackController`). */
export interface ProviderHolds {
	isProviderSpent(provider: string): boolean;
	accountError(provider: string): string | undefined;
	accountResetAt(provider: string): number | undefined;
	heldFamily(model: Model<Api>): { readonly family: string; readonly errorMessage: string } | undefined;
}

/** The hold that refuses queued input on `model`'s provider: a spent account, else a held family (senpi#3131). */
export function queuedInputHold(holds: ProviderHolds, model: Model<Api> | undefined): QueuedInputHold | undefined {
	if (model === undefined) return undefined;
	const { provider } = model;
	if (holds.isProviderSpent(provider)) {
		const resetAt = holds.accountResetAt(provider);
		const refusal = new AccountUsageLimitError(provider, holds.accountError(provider), resetAt);
		return { provider, message: refusal.message, ...(resetAt === undefined ? {} : { resetAt }) };
	}
	const family = holds.heldFamily(model);
	if (family === undefined) return undefined;
	return {
		provider,
		message: new AccountUsageLimitError(provider, family.errorMessage, undefined, [family.family]).message,
	};
}

/**
 * What happens to a follow-up still queued when a run ends on a provider error (senpi#6868). A person's abort, a
 * cancelled or blocked retry, a local failure and a required compaction keep it for the next prompt and never reach
 * this decision. Otherwise the session is idle and nothing else will drain the queue, so the follow-up starts its own
 * turn, unless the provider is held: then it fails typed, naming the hold, so a held account is never asked again by
 * a queue (senpi#3131).
 */
export type QueuedInputAfterError =
	| { readonly kind: "start" }
	| { readonly kind: "fail"; readonly hold: QueuedInputHold };

export function queuedInputAfterError(hold: QueuedInputHold | undefined): QueuedInputAfterError {
	return hold === undefined ? { kind: "start" } : { kind: "fail", hold };
}

type QueuedEntry = ClientMessageIdentity & {
	readonly queuedId: string;
	readonly text: string;
	readonly mode: "steer" | "followUp";
};

/**
 * Fails every queued follow-up under `hold`, in queue order. Each failure is published BEFORE its dequeue: the
 * per-input receipt (RPC client admissions) records the typed refusal first, so the dequeue's `queue_update` cannot
 * store the vanished input as completed (senpi#6869 review M1). Queued steering keeps its own rules.
 */
export async function failQueuedFollowUps(
	queued: readonly QueuedEntry[],
	hold: QueuedInputHold,
	session: {
		readonly emit: (event: QueuedInputFailedEvent) => void;
		readonly dequeue: (queuedId: string) => Promise<unknown>;
	},
): Promise<void> {
	for (const input of queued) {
		if (input.mode !== "followUp") continue;
		session.emit({
			type: "queued_input_failed",
			queuedId: input.queuedId,
			text: input.text,
			mode: input.mode,
			...clientMessageIdentity(input),
			error: {
				code: "account_usage_limit",
				provider: hold.provider,
				message: hold.message,
				...(hold.resetAt === undefined ? {} : { resetAt: hold.resetAt }),
			},
		});
		await session.dequeue(input.queuedId);
	}
}
