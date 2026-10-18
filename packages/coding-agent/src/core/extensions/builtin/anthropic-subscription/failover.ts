import type { CredentialStore } from "@earendil-works/pi-ai";
import { AUTH_BLOCK_REPROBE_MS } from "../../../credential-pool/auth-reprobe.ts";
import {
	activeModelBlockUntil,
	mergeModelBlocks,
	modelBlockKey,
	pruneModelBlocks,
	withModelBlock,
} from "../../../credential-pool/model-scope.ts";
import { usageLimitResetMs } from "../../../credential-pool/reset-time.ts";
import type { AccountSlot, AnthropicSubscriptionCredential } from "./accounts.ts";
import { clearExpiredBlocks } from "./affinity.ts";
import type { SdkErrorClassification } from "./errors.ts";
import { isConfirmedAccountUsageLimit, usageLimitBlockMs } from "./usage-limit-block.ts";

export const MAX_RATE_LIMIT_BLOCK_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_RATE_LIMIT_BLOCK_MS = 60_000;
/** Same-account retries per turn for a transient failure (overload, network, server error); it never rotates. */
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
	/** Records a refused 1M window so the retry, built by `runAttempt`, requests the standard one. */
	onLongContextRefused?: () => void;
	/** The session this turn belongs to: blocks that bind only this session are remembered under it. */
	sessionKey?: string;
};

type BlockFields = Pick<AccountSlot, "blockedUntil" | "blockReason" | "blockedAt" | "modelBlocks">;

/**
 * Blocks that bind only the session that hit them, in memory for the process: a plain rate limit and a
 * one-model limit. Another session on the same account keeps using it and finds out on its own request.
 */
const sessionBlocks = new Map<string, Map<string, BlockFields>>();

/**
 * Only a verdict that the account itself cannot serve anyone is shared through the credential store: a
 * confirmed account-level usage limit, a billing or organization refusal, or a rejected token. Moving
 * every session off the account is right then, since leaving them would retry a dead account. A plain
 * rate limit, an overload or a one-model limit is not that verdict, so it never moves other sessions
 * (senpi#3466).
 */
function isSharedVerdict(classification: SdkErrorClassification, error: unknown): boolean {
	if (
		classification.kind === "auth_error" ||
		classification.kind === "billing" ||
		classification.kind === "org_not_allowed"
	)
		return true;
	return (
		classification.kind === "rate_limit" &&
		classification.modelFamily === undefined &&
		isConfirmedAccountUsageLimit(errorText(error))
	);
}

function rememberSessionBlock(sessionKey: string | undefined, account: AccountSlot): void {
	if (sessionKey === undefined) return;
	const blocks = sessionBlocks.get(sessionKey) ?? new Map<string, BlockFields>();
	blocks.set(account.name, {
		blockedUntil: account.blockedUntil,
		blockReason: account.blockReason,
		blockedAt: account.blockedAt,
		modelBlocks: account.modelBlocks,
	});
	sessionBlocks.set(sessionKey, blocks);
}

/** Drops elapsed session blocks for every session, so sessions that ended leave nothing behind. */
function pruneSessionBlocks(now: number): void {
	for (const [sessionKey, blocks] of sessionBlocks) {
		for (const [name, block] of blocks) {
			if ((block.blockedUntil ?? 0) <= now && pruneModelBlocks(block.modelBlocks, now) === undefined)
				blocks.delete(name);
		}
		if (blocks.size === 0) sessionBlocks.delete(sessionKey);
	}
}

function withSessionBlocks(
	accounts: readonly AccountSlot[],
	sessionKey: string | undefined,
	now: number,
): AccountSlot[] {
	pruneSessionBlocks(now);
	const blocks = sessionKey === undefined ? undefined : sessionBlocks.get(sessionKey);
	if (blocks === undefined) return [...accounts];
	return accounts.map((account) => {
		const own = blocks.get(account.name);
		if (own === undefined) return account;
		const later = (own.blockedUntil ?? 0) > (account.blockedUntil ?? 0);
		return {
			...account,
			...(later ? { blockedUntil: own.blockedUntil, blockReason: own.blockReason, blockedAt: own.blockedAt } : {}),
			modelBlocks: mergeModelBlocks(account.modelBlocks, own.modelBlocks, 0),
		};
	});
}

function forgetSessionBlock(sessionKey: string | undefined, name: string): void {
	if (sessionKey === undefined) return;
	const blocks = sessionBlocks.get(sessionKey);
	if (!blocks?.delete(name)) return;
	if (blocks.size === 0) sessionBlocks.delete(sessionKey);
}

/** `/claude-account unblock` lifts the account's session-scoped blocks in every session too. Returns whether one was lifted. */
export function forgetSessionBlocksFor(name: string): boolean {
	let lifted = false;
	for (const [sessionKey, blocks] of [...sessionBlocks]) {
		if (!blocks.has(name)) continue;
		lifted = true;
		forgetSessionBlock(sessionKey, name);
	}
	return lifted;
}

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
		return { ...account, blockedUntil: now + AUTH_BLOCK_REPROBE_MS, blockReason: "auth_error", blockedAt: now };
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
	// A spent account is out until its limit resets, capped at the limit's own window; a fixed
	// short block sent a pinned account back to the same limit every minute (senpi#3462).
	const hinted = retryAfterMs(error) ?? usageLimitBlockMs(errorText(error), account.name, now);
	const duration = Math.min(MAX_RATE_LIMIT_BLOCK_MS, hinted ?? fallback);
	return { ...account, blockedUntil: now + duration, blockReason: classification.kind, blockedAt: now };
}

/**
 * An account that just served a turn is not spent: a limit block stored before the turn started (a
 * misread reset, a stale failure) is cleared so it cannot hold a working account out. A block stored
 * after the turn started is newer evidence than this success and stays. Auth blocks keep their re-probe.
 */
async function clearBlockAfterSuccess(
	store: CredentialStore,
	providerId: string,
	name: string,
	startedAt: number,
): Promise<void> {
	const clearable = (slot: { blockedUntil?: number; blockReason?: string; blockedAt?: number } | undefined) =>
		slot?.blockedUntil !== undefined && slot.blockReason !== "auth_error" && (slot.blockedAt ?? 0) <= startedAt;
	const stored = await store.read(providerId);
	if (stored?.type !== "oauth") return;
	const read = stored as AnthropicSubscriptionCredential;
	const slot = read.accounts?.find((account) => account.name === name) ?? read.slotState?.[name];
	if (!clearable(slot)) return;
	await store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as AnthropicSubscriptionCredential;
		const state = credential.slotState?.[name];
		const slotState =
			state === undefined || !clearable(state)
				? credential.slotState
				: { ...credential.slotState, [name]: { ...(state.modelBlocks ? { modelBlocks: state.modelBlocks } : {}) } };
		return {
			...credential,
			...(slotState === undefined ? {} : { slotState }),
			accounts: (credential.accounts ?? []).map((account) => {
				if (account.name !== name || !clearable(account)) return account;
				const { blockedUntil: _blockedUntil, blockReason: _blockReason, blockedAt: _blockedAt, ...rest } = account;
				return rest;
			}),
		};
	});
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
						...(account.blockedAt === undefined ? {} : { blockedAt: account.blockedAt }),
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
						...(account.blockedAt === undefined ? {} : { blockedAt: account.blockedAt }),
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
 * Runs one attempt per account for account-level failures (a limit, billing, auth), plus at most
 * TRANSIENT_RETRIES_PER_TURN same-account retries for a transient failure, after which the turn fails on
 * that account instead of rotating (and one retry on newer stored credentials). A retry is transparent only
 * before a text, thinking, or tool-call event reaches the caller; post-delta failures are marked so
 * AgentSession never replays the partial turn.
 */
export async function* runFailover<TEvent>(options: FailoverOptions<TEvent>): AsyncGenerator<TEvent> {
	const now = options.now ?? Date.now;
	const baseBlockMs = options.baseBlockMs ?? DEFAULT_RATE_LIMIT_BLOCK_MS;
	let accounts = clearExpiredBlocks(withSessionBlocks(options.accounts, options.sessionKey, now()), now());
	let lastError: ClassifiedSdkError | undefined;
	const retriedOnStoredMaterial = new Set<string>();
	let transientRetriesUsed = 0;
	let longContextRetried = false;
	let retryAccountName: string | undefined;

	for (let attempt = 0; attempt < accounts.length; attempt++) {
		// Each attempt gets its own copy: prepareSlot refreshes the slot in place, and a concurrent
		// attempt holding the same stored object must still report the token it actually sent.
		const retrySlot =
			retryAccountName === undefined ? undefined : accounts.find((slot) => slot.name === retryAccountName);
		retryAccountName = undefined;
		const account = { ...(retrySlot ?? options.selectFn(accounts)) };
		let visibleDeltaEmitted = false;
		let completed = false;
		const startedAt = now();
		try {
			const attemptStream = await options.runAttempt(account);
			for await (const event of attemptStream) {
				const failure = (options.errorFromEvent ?? defaultErrorFromEvent)(event);
				if (failure !== undefined) throw failure;
				visibleDeltaEmitted ||= (options.isVisibleDelta ?? defaultIsVisibleDelta)(event);
				yield event;
			}
			completed = true;
		} catch (error) {
			const classification = options.classify(error);
			const classified = new ClassifiedSdkError(classification, error, visibleDeltaEmitted);
			lastError = classified;
			if (!classification.retryable) throw classified;

			// A refused 1M window is the account's entitlement, not a limit: never block or rotate it.
			// Retry once on the same account at the standard window (senpi#3408).
			if (classification.kind === "long_context_unavailable") {
				if (visibleDeltaEmitted || longContextRetried) throw classified;
				longContextRetried = true;
				options.onLongContextRefused?.();
				retryAccountName = account.name;
				attempt--;
				continue;
			}

			// A transient failure says nothing about the account: it is retried in place a bounded
			// number of times, then the turn fails on this account and the session's own retry and
			// model fallback take over. It never blocks or rotates the account: moving to another
			// account writes the whole conversation to a cold prompt cache, and a persisted block would
			// move every other session off a healthy account too (senpi#2891, senpi#3466).
			if (isTransient(classification)) {
				if (visibleDeltaEmitted || transientRetriesUsed >= TRANSIENT_RETRIES_PER_TURN) throw classified;
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
			// With no session to hold it, a block is shared as before: dropping it would re-send every
			// sessionless request to the spent account until its window resets.
			const shared = isSharedVerdict(classification, error) || options.sessionKey === undefined;
			if (!shared) rememberSessionBlock(options.sessionKey, blocked);
			const superseded = shared ? await persistBlock(options.store, options.providerId, blocked, now()) : undefined;
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
		if (completed) {
			forgetSessionBlock(options.sessionKey, account.name);
			// Outside the attempt's try: clearing is best-effort hygiene after a finished turn, so a store
			// failure is logged and the block stays for the next success; it never fails or replays the turn.
			await clearBlockAfterSuccess(options.store, options.providerId, account.name, startedAt).catch(
				(error: unknown) => {
					process.stderr.write(
						`senpi anthropic-subscription: could not clear a stored block on ${account.name}: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				},
			);
			return;
		}
	}
	throw lastError ?? new Error("Anthropic Subscription failover exhausted without an attempt");
}
