import type { CredentialStore } from "@earendil-works/pi-ai";
import {
	activeModelBlockUntil,
	mergeModelBlocks,
	modelBlockKey,
	withModelBlock,
} from "../../../credential-pool/model-scope.ts";
import { usageLimitResetMs } from "../../../credential-pool/reset-time.ts";
import type { AccountSlot, AnthropicSubscriptionCredential } from "./accounts.ts";
import { clearExpiredBlocks } from "./affinity.ts";
import type { SdkErrorClassification } from "./errors.ts";

export const MAX_RATE_LIMIT_BLOCK_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_RATE_LIMIT_BLOCK_MS = 60_000;
/** Same-account retries per turn for a transient failure (overload, network, server error) before rotating. */
export const TRANSIENT_RETRIES_PER_TURN = 2;
export const TRANSIENT_RETRY_DELAY_MS = 1_000;
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
	/** The requested model; a limit naming its family blocks only that family on the account. */
	model?: string;
	now?: () => number;
	baseBlockMs?: number;
	onFailover?: (event: FailoverEvent) => void | Promise<void>;
	errorFromEvent?: (event: TEvent) => unknown | undefined;
	isVisibleDelta?: (event: TEvent) => boolean;
	/** Waits before a transient same-account retry; injectable for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
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
	model: string | undefined,
): AccountSlot {
	if (classification.kind === "auth_error") {
		const { blockedUntil: _blockedUntil, ...withoutExpiry } = account;
		return { ...withoutExpiry, blockReason: "auth_error" };
	}
	const fallback = Math.min(MAX_RATE_LIMIT_BLOCK_MS, baseBlockMs * 2 ** attempt);
	if (classification.modelFamily !== undefined && model !== undefined) {
		// A model-scoped limit lasts until its own reset, which Claude Code states in
		// the text ("resets 8pm"); the account itself keeps serving other models.
		const resetMs = retryAfterMs(error) ?? usageLimitResetMs(errorText(error), now);
		const duration = Math.min(MAX_RATE_LIMIT_BLOCK_MS, resetMs !== undefined && resetMs > 0 ? resetMs : fallback);
		const key = modelBlockKey(classification.modelFamily, model);
		return { ...account, modelBlocks: withModelBlock(account.modelBlocks, key, now + duration, now) };
	}
	const duration = Math.min(MAX_RATE_LIMIT_BLOCK_MS, retryAfterMs(error) ?? fallback);
	return { ...account, blockedUntil: now + duration, blockReason: classification.kind };
}

function isTransient(classification: SdkErrorClassification): boolean {
	return classification.kind === "overloaded" || classification.kind === "other";
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function replaceAccount(accounts: readonly AccountSlot[], replacement: AccountSlot): AccountSlot[] {
	return accounts.map((account) => (account.name === replacement.name ? replacement : account));
}

/**
 * Persists a block onto the stored slot. An `auth_error` is a verdict on the
 * token that failed, so it is written only while the stored slot still holds
 * that token. When another writer replaced the material meanwhile (a refresh in
 * this or another process, or a re-login), nothing is written and the stored
 * slot is returned: locking it "until re-login" would strand a valid token.
 */
async function persistBlock(
	store: CredentialStore,
	providerId: string,
	account: AccountSlot,
	now: number,
): Promise<AccountSlot | undefined> {
	let superseded: AccountSlot | undefined;
	await store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		if (account.source === "env") {
			return {
				...credential,
				slotState: {
					...credential.slotState,
					[account.name]: {
						blockedUntil: account.blockedUntil,
						blockReason: account.blockReason,
						// Union with what a concurrent request stored meanwhile, later expiry winning.
						modelBlocks: mergeModelBlocks(
							credential.slotState?.[account.name]?.modelBlocks,
							account.modelBlocks,
							now,
						),
					},
				},
			};
		}
		const stored = (credential.accounts ?? []).find((existing) => existing.name === account.name);
		if (
			account.blockReason === "auth_error" &&
			stored !== undefined &&
			(stored.access !== account.access || stored.refresh !== account.refresh)
		) {
			superseded = stored;
			return current;
		}
		const accounts = (credential.accounts ?? []).map((existing) =>
			existing.name === account.name
				? {
						...existing,
						blockedUntil: account.blockedUntil,
						blockReason: account.blockReason,
						modelBlocks: mergeModelBlocks(existing.modelBlocks, account.modelBlocks, now),
					}
				: existing,
		);
		return { ...credential, accounts };
	});
	return superseded;
}

function usable(account: AccountSlot, now: number, model: string | undefined): boolean {
	return (
		account.blockReason === undefined &&
		(account.blockedUntil === undefined || account.blockedUntil <= now) &&
		activeModelBlockUntil(account.modelBlocks, model, now) === undefined
	);
}

/**
 * Runs one attempt per account, plus at most TRANSIENT_RETRIES_PER_TURN same-account retries
 * for a transient failure (and one retry on newer stored credentials). A retry is transparent only before a
 * text, thinking, or tool-call event reaches the caller; post-delta failures
 * are marked so AgentSession never replays the partial turn.
 */
export async function* runFailover<TEvent>(options: FailoverOptions<TEvent>): AsyncGenerator<TEvent> {
	const now = options.now ?? Date.now;
	const baseBlockMs = options.baseBlockMs ?? DEFAULT_RATE_LIMIT_BLOCK_MS;
	let accounts = clearExpiredBlocks(options.accounts, now());
	let lastError: ClassifiedSdkError | undefined;
	const retriedOnStoredMaterial = new Set<string>();
	let transientRetriesUsed = 0;
	let retryAccountName: string | undefined;

	for (let attempt = 0; attempt < accounts.length; attempt++) {
		// Each attempt gets its own copy: prepareSlot refreshes the slot in place, and a concurrent
		// attempt holding the same stored object must still report the token it actually sent.
		const retrySlot =
			retryAccountName === undefined ? undefined : accounts.find((slot) => slot.name === retryAccountName);
		retryAccountName = undefined;
		const account = { ...(retrySlot ?? options.selectFn(accounts)) };
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

			// A transient failure says nothing about the account, and on the config-dir lane moving
			// to another account re-sends the whole conversation (senpi#2891): retry it in place first.
			// The budget is per turn, not per account: an outage that fails every account must not
			// multiply into retries on each of them.
			if (!visibleDeltaEmitted && isTransient(classification) && transientRetriesUsed < TRANSIENT_RETRIES_PER_TURN) {
				const delayMs = TRANSIENT_RETRY_DELAY_MS * 2 ** transientRetriesUsed;
				transientRetriesUsed += 1;
				try {
					await (options.sleep ?? abortableSleep)(delayMs, options.signal);
				} catch {
					throw classified;
				}
				retryAccountName = account.name;
				attempt--;
				continue;
			}

			const blocked = blockedAccount(account, classification, now(), attempt, baseBlockMs, error, options.model);
			const superseded = await persistBlock(options.store, options.providerId, blocked, now());
			if (
				superseded &&
				!visibleDeltaEmitted &&
				usable(superseded, now(), options.model) &&
				!retriedOnStoredMaterial.has(account.name)
			) {
				// The rejected token was already replaced in the store: retry this
				// account once on the stored material instead of failing over.
				retriedOnStoredMaterial.add(account.name);
				accounts = replaceAccount(accounts, superseded);
				attempt--;
				continue;
			}
			accounts = replaceAccount(accounts, blocked);
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
