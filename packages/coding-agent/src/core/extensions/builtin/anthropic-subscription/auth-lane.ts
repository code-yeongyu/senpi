import { createHash } from "node:crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import { CredentialStoreBusyError } from "../../../lockfile-policy.ts";
import { emitProviderAccountFailover, emitProviderAccountsChanged } from "./account-events.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
	envSlotToken,
	listAccounts,
	refreshSlot,
	type SlotRefresher,
} from "./accounts.ts";
import { isBlockedFor, selectAccount } from "./affinity.ts";
import { type AuthenticatedAttemptInput, createAttemptMessages, type RetainableAttempt } from "./auth-attempt.ts";
import { recoverAuthBlockedSlots } from "./auth-block-recovery.ts";
import { hasRequestOauthToken, mergeRequestAuthEnvironment, stripManagedAuthEnvironment } from "./auth-environment.ts";
import { writeConfigDirCredential } from "./config-dir-credentials.ts";
import { classifySdkError, sdkAssistantFailure, sdkResultFailure } from "./errors.ts";
import { runFailover } from "./failover.ts";
import { isGrantRejected, refreshFailure } from "./refresh-failure.ts";
import { refusalError } from "./refusal.ts";
import type { Options, SDKMessage, SdkQuery } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionProviderSettings, AnthropicSubscriptionTokenInjection } from "./settings.ts";

export { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";

export const EXPIRING_WITHIN_MS = 5 * 60_000;

/** A managed lane with an empty pool must refuse rather than spawn the SDK against ambient host credentials. */
const NO_MANAGED_ACCOUNTS_ERROR =
	"authentication_failed: No Anthropic Subscription accounts configured for the managed lane; " +
	"run /login anthropic-subscription or set CLAUDE_CODE_OAUTH_TOKEN";

type AuthLaneBoundary = {
	createStore: () => CredentialStore;
	env: () => NodeJS.ProcessEnv;
	getAgentDir: () => string;
	now: () => number;
	refresher: SlotRefresher;
};

async function refreshWithAnthropicOAuth(refresh: string, signal: AbortSignal) {
	const oauth = await loadAnthropicOAuth();
	const credential = await oauth.refresh({ type: "oauth", access: "", refresh, expires: 0 }, signal);
	return { access: credential.access, refresh: credential.refresh, expires: credential.expires };
}

const defaultBoundary: AuthLaneBoundary = {
	createStore: () => AuthStorage.create(),
	env: () => process.env,
	getAgentDir,
	now: () => Date.now(),
	refresher: refreshWithAnthropicOAuth,
};
let activeBoundary = defaultBoundary;

export function overrideAuthLaneBoundary(override: Partial<AuthLaneBoundary>): void {
	activeBoundary = { ...activeBoundary, ...override };
}

export function resetAuthLaneBoundary(): void {
	activeBoundary = defaultBoundary;
}

export type { AuthenticatedAttemptInput } from "./auth-attempt.ts";

export type AuthenticatedQueryInput = {
	prompt: Parameters<SdkQuery>[0]["prompt"];
	query: SdkQuery;
	buildOptions: (lane: AnthropicSubscriptionTokenInjection) => Options;
	providerSettings: AnthropicSubscriptionProviderSettings;
	/** Effective request auth environment; overrides the host for account discovery and SDK spawn. */
	env?: Record<string, string>;
	signal?: AbortSignal;
	sessionId?: string;
	/** The requested model id: a usage limit on one model family blocks only that family (senpi#2555). */
	model?: string;
	/** Request-scoped CLI pin; takes precedence over persistent settings and account pins. */
	pinnedAccount?: string;
	/** The account this session's SDK transcript lives under; preferred while it can serve (senpi#2891). */
	preferredAccount?: string;
	onQuery?: (query: ReturnType<SdkQuery>) => void;
	createAttempt?: (
		input: AuthenticatedAttemptInput,
	) => RetainableAttempt<SDKMessage> | Promise<RetainableAttempt<SDKMessage>>;
};

type ManagedPool = {
	accounts: AccountSlot[];
	environment: NodeJS.ProcessEnv;
	lane: Exclude<AnthropicSubscriptionTokenInjection, "ambient">;
	pinnedAccount?: string;
	store: CredentialStore;
};

export function resolveEffectiveLane(
	settings: AnthropicSubscriptionProviderSettings,
	accounts: readonly AccountSlot[],
): AnthropicSubscriptionTokenInjection {
	return settings.tokenInjection ?? (accounts.length > 0 ? "oauth-slots" : "ambient");
}

async function managedPool(
	settings: AnthropicSubscriptionProviderSettings,
	requestEnvironment?: Record<string, string>,
): Promise<ManagedPool | undefined> {
	const store = activeBoundary.createStore();
	let credential = await store.read(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
	const environment = mergeRequestAuthEnvironment(activeBoundary.env(), requestEnvironment);
	let accounts = listAccounts(
		(credential as AnthropicSubscriptionCredential | undefined) ?? emptyCredential(),
		(name) => environment[name],
	);
	if (!credential && accounts.length > 0) {
		credential = await store.modify(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, async () => emptyCredential());
		accounts = listAccounts(
			(credential as AnthropicSubscriptionCredential) ?? emptyCredential(),
			(name) => environment[name],
		);
	}
	const configuredLane = resolveEffectiveLane(settings, accounts);
	const lane =
		configuredLane === "config-dir" && hasRequestOauthToken(requestEnvironment) ? "oauth-slots" : configuredLane;
	if (lane === "ambient") return undefined;
	if (accounts.length === 0) throw new Error(NO_MANAGED_ACCOUNTS_ERROR);
	const stored = credential?.type === "oauth" ? (credential as AnthropicSubscriptionCredential) : undefined;
	return { accounts, environment, lane, pinnedAccount: settings.pinnedAccount ?? stored?.pinned, store };
}

function storedAccounts(credential: Credential | undefined, pool: ManagedPool): AccountSlot[] {
	const stored = credential?.type === "oauth" ? (credential as AnthropicSubscriptionCredential) : undefined;
	return listAccounts(stored ?? emptyCredential(), (key) => pool.environment[key]);
}

function storedSlot(credential: Credential | undefined, pool: ManagedPool, name: string): AccountSlot | undefined {
	return storedAccounts(credential, pool).find((candidate) => candidate.name === name);
}

/**
 * Another writer holds auth.json for longer than the lock budget, almost always
 * a sibling session redeeming this same slot. Contention says nothing about the
 * credential: adopt the sibling's rotated token, or keep the stored one while it
 * is still inside its lifetime (the refresh window opens before expiry).
 */
async function continueWhileStoreBusy(pool: ManagedPool, slot: AccountSlot, busy: Error): Promise<void> {
	const latest = storedSlot(await pool.store.read(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID), pool, slot.name);
	if (latest && latest.refresh !== slot.refresh) {
		Object.assign(slot, latest);
		return;
	}
	if (activeBoundary.now() < slot.expires) return;
	throw busy;
}

async function prepareSlot(
	pool: ManagedPool,
	selected: AccountSlot,
	signal: AbortSignal,
): Promise<{ env: Record<string, string | undefined>; credentialDigest: string }> {
	const environment = pool.environment;
	const slot = selected;
	if (slot.source !== "env" && activeBoundary.now() >= slot.expires - EXPIRING_WITHIN_MS) {
		try {
			const refreshed = await refreshSlot(
				pool.store,
				ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
				slot.name,
				activeBoundary.refresher,
				signal,
				(expires) => activeBoundary.now() >= expires - EXPIRING_WITHIN_MS,
			);
			const updated = storedSlot(refreshed, pool, slot.name);
			if (!updated) throw new Error("selected account disappeared during refresh");
			Object.assign(slot, updated);
		} catch (error) {
			// A cancelled turn is not an authentication verdict: an aborted refresh
			// must not surface as authentication_failed and auth-block the account.
			signal.throwIfAborted();
			if (!(error instanceof CredentialStoreBusyError)) throw refreshFailure(error);
			await continueWhileStoreBusy(pool, slot, error);
		}
	}
	const access = slot.source === "env" ? envSlotToken((name) => environment[name], slot.name) : slot.access;
	if (!access) throw new Error("authentication_failed: selected OAuth token is unavailable");
	const childEnvironment = stripManagedAuthEnvironment(environment);
	const credentialDigest = createHash("sha256").update(access).digest("hex");
	if (pool.lane === "oauth-slots") {
		return { env: { ...childEnvironment, CLAUDE_CODE_OAUTH_TOKEN: access }, credentialDigest };
	}
	const directory = writeConfigDirCredential(activeBoundary.getAgentDir(), slot, access);
	return { env: { ...childEnvironment, CLAUDE_CONFIG_DIR: directory }, credentialDigest };
}

function sdkFailure(message: SDKMessage): unknown | undefined {
	const refusal = refusalError(message);
	if (refusal) return refusal;
	if (message.type === "assistant") return sdkAssistantFailure(message);
	if (message.type === "result") return sdkResultFailure(message);
	return undefined;
}

function visibleSdkMessage(message: SDKMessage): boolean {
	if (message.type !== "stream_event") return false;
	return /^(?:content_block_start|content_block_delta|content_block_stop)$/.test(message.event.type);
}

/** Resolves managed OAuth immediately before each subprocess spawn and retries only pre-delta failures. */
export async function* queryWithAuthLane(input: AuthenticatedQueryInput): AsyncGenerator<SDKMessage> {
	const signal = input.signal ?? new AbortController().signal;
	const pool = await managedPool(input.providerSettings, input.env);
	if (!pool) {
		const options = input.buildOptions("ambient");
		const parentEnvironment = mergeRequestAuthEnvironment(activeBoundary.env(), input.env);
		const ambientEnvironment: Record<string, string | undefined> = { ...parentEnvironment };
		for (const name of Object.keys(ambientEnvironment)) {
			if (name.startsWith("SENPI_")) delete ambientEnvironment[name];
		}
		// Lane-owned variables from buildOptions (the compaction-owner overlay) win over the host.
		options.env = { ...ambientEnvironment, ...options.env };
		yield* await createAttemptMessages(input, {
			accountName: "ambient",
			accounts: [],
			authLane: "ambient",
			options,
		});
		return;
	}
	pool.accounts = await recoverAuthBlockedSlots({
		store: pool.store,
		providerId: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
		accounts: pool.accounts,
		refresher: activeBoundary.refresher,
		signal,
		isGrantRejected,
		reload: async () => storedAccounts(await pool.store.read(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID), pool),
		isUsable: (account) => !isBlockedFor(account, activeBoundary.now(), input.model),
		transientError: (error) => (error instanceof CredentialStoreBusyError ? error : refreshFailure(error)),
	});
	yield* runFailover({
		accounts: pool.accounts,
		selectFn: (accounts) =>
			selectAccount(accounts, {
				sessionId: input.sessionId,
				pinnedAccount: input.pinnedAccount ?? pool.pinnedAccount,
				...(input.preferredAccount === undefined ? {} : { preferredAccount: input.preferredAccount }),
				now: activeBoundary.now(),
				...(input.model === undefined ? {} : { model: input.model }),
			}),
		runAttempt: async (slot) => {
			const options = input.buildOptions(pool.lane);
			const accounts = pool.accounts.map((account) => ({ ...account }));
			const prepared = await prepareSlot(pool, slot, signal);
			options.env = { ...prepared.env, ...options.env };
			return createAttemptMessages(input, {
				accountName: slot.name,
				accounts,
				authLane: pool.lane,
				options,
				credentialDigest: prepared.credentialDigest,
			});
		},
		classify: classifySdkError,
		store: pool.store,
		providerId: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
		...(input.model === undefined ? {} : { model: input.model }),
		now: activeBoundary.now,
		errorFromEvent: sdkFailure,
		isVisibleDelta: visibleSdkMessage,
		signal,
		onFailover: ({ account, nextAccount, classification }) => {
			emitProviderAccountsChanged(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
			if (nextAccount) {
				emitProviderAccountFailover(
					ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
					account.name,
					nextAccount.name,
					classification.kind,
				);
			}
		},
	});
}
