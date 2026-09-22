import type { CredentialStore } from "@earendil-works/pi-ai";
import type { AccountSlot, AnthropicSubscriptionCredential } from "./accounts.ts";
import { clearExpiredBlocks } from "./affinity.ts";
import type { SdkErrorClassification } from "./errors.ts";

export const MAX_RATE_LIMIT_BLOCK_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_RATE_LIMIT_BLOCK_MS = 60_000;
export const TURN_RETRY_SUPPRESSION_PREFIX = "senpi:no-turn-retry:";

type RecordValue = Record<string, unknown>;

export type FailoverEvent = {
	account: AccountSlot;
	nextAccount?: AccountSlot;
	classification: SdkErrorClassification;
	attempt: number;
	visibleDeltaEmitted: boolean;
};

export type FailoverOptions<TEvent> = {
	accounts: readonly AccountSlot[];
	selectFn: (accounts: readonly AccountSlot[]) => AccountSlot;
	runAttempt: (slot: AccountSlot) => AsyncIterable<TEvent> | Promise<AsyncIterable<TEvent>>;
	classify: (error: unknown) => SdkErrorClassification;
	store: CredentialStore;
	providerId: string;
	now?: () => number;
	baseBlockMs?: number;
	onFailover?: (event: FailoverEvent) => void | Promise<void>;
	errorFromEvent?: (event: TEvent) => unknown | undefined;
	isVisibleDelta?: (event: TEvent) => boolean;
};

export class ClassifiedSdkError extends Error {
	readonly classification: SdkErrorClassification;
	readonly original: unknown;
	readonly suppressTurnRetry: boolean;

	constructor(classification: SdkErrorClassification, original: unknown, suppressTurnRetry: boolean) {
		const detail = original instanceof Error ? original.message : String(original);
		super(`${suppressTurnRetry ? TURN_RETRY_SUPPRESSION_PREFIX : ""}${detail}`);
		this.name = "ClassifiedSdkError";
		this.classification = classification;
		this.original = original;
		this.suppressTurnRetry = suppressTurnRetry;
	}
}

function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function defaultErrorFromEvent<TEvent>(event: TEvent): unknown | undefined {
	const value = record(event);
	return value?.type === "error" ? value.error : undefined;
}

function defaultIsVisibleDelta<TEvent>(event: TEvent): boolean {
	const value = record(event);
	if (typeof value?.type !== "string") return false;
	return /^(?:text|thinking|toolcall)_(?:start|delta|end)$/.test(value.type);
}

function errorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	const value = record(error);
	return typeof value?.message === "string" ? value.message : String(error);
}

function retryAfterMs(error: unknown): number | undefined {
	const value = record(error);
	const explicit = value?.retryAfterMs;
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
	const text = errorText(error);
	const milliseconds = text.match(/\bretry[-_ ]?after[-_ ]?ms\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	if (milliseconds) return Math.ceil(Number(milliseconds[1]));
	const seconds = text.match(/\bretry[-_ ]?after\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	return seconds ? Math.ceil(Number(seconds[1]) * 1_000) : undefined;
}

function blockedAccount(
	account: AccountSlot,
	classification: SdkErrorClassification,
	now: number,
	attempt: number,
	baseBlockMs: number,
	error: unknown,
): AccountSlot {
	if (classification.kind === "auth_error") {
		const { blockedUntil: _blockedUntil, ...withoutExpiry } = account;
		return { ...withoutExpiry, blockReason: "auth_error" };
	}
	const fallback = Math.min(MAX_RATE_LIMIT_BLOCK_MS, baseBlockMs * 2 ** attempt);
	const duration = Math.min(MAX_RATE_LIMIT_BLOCK_MS, retryAfterMs(error) ?? fallback);
	return { ...account, blockedUntil: now + duration, blockReason: classification.kind };
}

function replaceAccount(accounts: readonly AccountSlot[], replacement: AccountSlot): AccountSlot[] {
	return accounts.map((account) => (account.name === replacement.name ? replacement : account));
}

async function persistBlock(store: CredentialStore, providerId: string, account: AccountSlot): Promise<void> {
	await store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		if (account.source === "env") {
			return {
				...credential,
				slotState: {
					...credential.slotState,
					[account.name]: { blockedUntil: account.blockedUntil, blockReason: account.blockReason },
				},
			};
		}
		const accounts = (credential.accounts ?? []).map((existing) =>
			existing.name === account.name
				? { ...existing, blockedUntil: account.blockedUntil, blockReason: account.blockReason }
				: existing,
		);
		return { ...credential, accounts };
	});
}

/**
 * Runs at most one attempt per account. A retry is transparent only before a
 * text, thinking, or tool-call event reaches the caller; post-delta failures
 * are marked so AgentSession never replays the partial turn.
 */
export async function* runFailover<TEvent>(options: FailoverOptions<TEvent>): AsyncGenerator<TEvent> {
	const now = options.now ?? Date.now;
	const baseBlockMs = options.baseBlockMs ?? DEFAULT_RATE_LIMIT_BLOCK_MS;
	let accounts = clearExpiredBlocks(options.accounts, now());
	let lastError: ClassifiedSdkError | undefined;

	for (let attempt = 0; attempt < accounts.length; attempt++) {
		const account = options.selectFn(accounts);
		let visibleDeltaEmitted = false;
		try {
			const attemptStream = await options.runAttempt(account);
			for await (const event of attemptStream) {
				const failure = (options.errorFromEvent ?? defaultErrorFromEvent)(event);
				if (failure !== undefined) throw failure;
				visibleDeltaEmitted ||= (options.isVisibleDelta ?? defaultIsVisibleDelta)(event);
				yield event;
			}
			return;
		} catch (error) {
			const classification = options.classify(error);
			const classified = new ClassifiedSdkError(classification, error, visibleDeltaEmitted);
			lastError = classified;
			if (!classification.retryable) throw classified;

			const blocked = blockedAccount(account, classification, now(), attempt, baseBlockMs, error);
			accounts = replaceAccount(accounts, blocked);
			await persistBlock(options.store, options.providerId, blocked);
			const event: FailoverEvent = {
				account: blocked,
				classification,
				attempt: attempt + 1,
				visibleDeltaEmitted,
			};
			try {
				if (!visibleDeltaEmitted && attempt + 1 < accounts.length) {
					event.nextAccount = options.selectFn(accounts);
				}
			} finally {
				await options.onFailover?.(event);
			}
			if (visibleDeltaEmitted) throw classified;
		}
	}
	throw lastError ?? new Error("Anthropic Subscription failover exhausted without an attempt");
}
