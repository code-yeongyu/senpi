import { createHash } from "node:crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { CredentialStoreBusyError } from "../../../lockfile-policy.ts";
import { emitProviderAccountFailover, emitProviderAccountsChanged } from "./account-events.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	type ClaudeCliAccountSlot,
	type EnvAccountSlot,
	emptyCredential,
	envSlotToken,
	listAccounts,
} from "./accounts.ts";
import { isBlockedFor, type PinSource, selectAccount } from "./affinity.ts";
import { type AuthenticatedAttemptInput, createAttemptMessages, type RetainableAttempt } from "./auth-attempt.ts";
import { recoverAuthBlockedSlots } from "./auth-block-recovery.ts";
import { activeBoundary } from "./auth-lane-boundary.ts";
import { hasRequestOauthToken, mergeRequestAuthEnvironment, stripManagedAuthEnvironment } from "./auth-environment.ts";
import { accountDirFor, claudeCliSharedRoot, ensureAccountDir } from "./claude-cli-account-dir.ts";
import { buildClaudeCliEnvironment } from "./claude-cli-environment.ts";
import { profileChanged, verifyClaudeCliInitialization } from "./claude-cli-token-source.ts";
import { writeConfigDirCredential } from "./config-dir-credentials.ts";
import { asksLegacyLongContext } from "./context-window.ts";
import { runFailover } from "./failover.ts";
import { logContinuityEvent } from "./session-observability.ts";
import { markLongContextRefused } from "./long-context.ts";
import { classifyForRequest, retryAtStandardWindowOnce, sdkFailure, visibleSdkMessage } from "./long-context-retry.ts";
import { refreshFailure } from "./refresh-failure.ts";
import type { AnthropicSubscriptionAuthLane } from "./options.ts";
import type { Options, SDKMessage, SdkQuery } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionProviderSettings, AnthropicSubscriptionTokenInjection } from "./settings.ts";
import { ClaudeSignInRequiredError, signInRequiredNames } from "./sign-in-again.ts";

export { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
export { overrideAuthLaneBoundary, resetAuthLaneBoundary } from "./auth-lane-boundary.ts";

/** A managed lane with an empty pool must refuse rather than spawn the SDK against ambient host credentials. */
const NO_MANAGED_ACCOUNTS_ERROR =
	"authentication_failed: No Anthropic Subscription accounts configured for the managed lane; " +
	"run /login anthropic-subscription or set CLAUDE_CODE_OAUTH_TOKEN";

export type { AuthenticatedAttemptInput } from "./auth-attempt.ts";

export type AuthenticatedQueryInput = {
	prompt: Parameters<SdkQuery>[0]["prompt"];
	query: SdkQuery;
	buildOptions: (lane: AnthropicSubscriptionAuthLane) => Options;
	providerSettings: AnthropicSubscriptionProviderSettings;
	/** Effective request auth environment; overrides the host for account discovery and SDK spawn. */
	env?: Record<string, string>;
	signal?: AbortSignal;
	sessionId?: string;
	/** The requested model id: a usage limit on one model family blocks only that family (senpi#2555). */
	model?: string;
	/** Request-scoped CLI pin; takes precedence over persistent settings and account pins. */
	pinnedAccount?: string;
	/**
	 * A connection test of `pinnedAccount` alone (senpi#4436): no auth-block recovery across the pool, the account
	 * is tried even while blocked, and no block is stored or cleared. Requires `pinnedAccount`.
	 */
	probe?: boolean;
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
	pinSource?: Exclude<PinSource, "cli">;
	accountOrder?: readonly string[];
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
	return {
		accounts,
		environment,
		lane,
		pinnedAccount: settings.pinnedAccount ?? stored?.pinned,
		...(settings.pinnedAccount !== undefined
			? { pinSource: "settings" as const }
			: stored?.pinned !== undefined
				? { pinSource: "stored" as const }
				: {}),
		...(stored?.order === undefined ? {} : { accountOrder: stored.order }),
		store,
	};
}

function storedAccounts(credential: Credential | undefined, pool: ManagedPool): AccountSlot[] {
	const stored = credential?.type === "oauth" ? (credential as AnthropicSubscriptionCredential) : undefined;
	return listAccounts(stored ?? emptyCredential(), (key) => pool.environment[key]);
}

function laneFor(pool: ManagedPool, slot: AccountSlot): AnthropicSubscriptionAuthLane {
	return slot.store === "claude-cli" ? "claude-cli" : pool.lane;
}

/**
 * A claude-cli account turn: no token, only the account's own config dir (its links repaired first, so the
 * transcript lands in the shared root). Every inherited auth variable is stripped, so the CLI can only use
 * the login in its own store.
 */
function prepareClaudeCliSlot(
	pool: ManagedPool,
	slot: ClaudeCliAccountSlot,
): { env: Record<string, string | undefined>; credentialDigest: string } {
	const accountDir = ensureAccountDir({
		agentDir: activeBoundary.getAgentDir(),
		dirId: slot.dirId,
		sharedRoot: claudeCliSharedRoot(pool.environment),
	});
	const env = buildClaudeCliEnvironment(pool.environment, { configDir: accountDir });
	return { env, credentialDigest: createHash("sha256").update(`claude-cli\0${accountDir}`).digest("hex") };
}

/**
 * Fails the attempt closed on an inherited credential. Only after the check passed is the profile the CLI reported
 * stored when it changed; that write is bookkeeping, so a busy or failing store is logged and never fails the turn.
 */
function claudeCliInitializationCheck(pool: ManagedPool, slot: ClaudeCliAccountSlot) {
	return async (initialization: unknown): Promise<void> => {
		const reported = verifyClaudeCliInitialization(initialization);
		if (!profileChanged(slot.profile, reported)) return;
		const profile = { ...reported, checkedAt: activeBoundary.now() };
		slot.profile = profile;
		try {
			await pool.store.modify(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, async (current) => {
				if (current?.type !== "oauth") return current;
				const credential = current as AnthropicSubscriptionCredential;
				return {
					...credential,
					accounts: (credential.accounts ?? []).map((candidate) =>
						candidate.name === slot.name && candidate.store === "claude-cli"
							? { ...candidate, profile }
							: candidate,
					),
				};
			});
		} catch (error) {
			logContinuityEvent("claude_cli_profile_write_failed", {
				accountName: slot.name,
				reason: error instanceof CredentialStoreBusyError ? "store_busy" : "store_error",
			});
		}
	};
}

/** An env token account's turn: the token goes to the SDK child, or into a per-account config dir on that lane. */
function prepareEnvSlot(
	pool: ManagedPool,
	slot: EnvAccountSlot,
): { env: Record<string, string | undefined>; credentialDigest: string } {
	const environment = pool.environment;
	const access = envSlotToken((name) => environment[name], slot.name);
	if (!access) throw new Error("authentication_failed: selected OAuth token is unavailable");
	const childEnvironment = stripManagedAuthEnvironment(environment);
	const credentialDigest = createHash("sha256").update(access).digest("hex");
	if (pool.lane === "oauth-slots") {
		return { env: { ...childEnvironment, CLAUDE_CODE_OAUTH_TOKEN: access }, credentialDigest };
	}
	const directory = writeConfigDirCredential(activeBoundary.getAgentDir(), slot, access);
	return { env: { ...childEnvironment, CLAUDE_CONFIG_DIR: directory }, credentialDigest };
}

/** Resolves managed OAuth immediately before each subprocess spawn and retries only pre-delta failures. */
export async function* queryWithAuthLane(input: AuthenticatedQueryInput): AsyncGenerator<SDKMessage> {
	const signal = input.signal ?? new AbortController().signal;
	const pool = await managedPool(input.providerSettings, input.env);
	if (!pool) {
		const parentEnvironment = mergeRequestAuthEnvironment(activeBoundary.env(), input.env);
		const ambientEnvironment: Record<string, string | undefined> = { ...parentEnvironment };
		for (const name of Object.keys(ambientEnvironment)) {
			if (name.startsWith("SENPI_")) delete ambientEnvironment[name];
		}
		// Lane-owned variables from buildOptions (the compaction-owner overlay) win over the host.
		let askedLegacyLongContext = false;
		const ambientAttempt = async () => {
			const options = input.buildOptions("ambient");
			askedLegacyLongContext = asksLegacyLongContext(options.model);
			options.env = { ...ambientEnvironment, ...options.env };
			return createAttemptMessages(input, { accountName: "ambient", accounts: [], authLane: "ambient", options });
		};
		yield* retryAtStandardWindowOnce(ambientAttempt, () => askedLegacyLongContext);
		return;
	}
	if (input.probe === true) {
		const probed = pool.accounts.find((account) => account.name === input.pinnedAccount);
		if (probed === undefined)
			throw new Error(`authentication_failed: no stored account named ${input.pinnedAccount}`);
		const { blockedUntil: _until, blockReason: _reason, blockedAt: _at, modelBlocks: _model, ...unblocked } = probed;
		pool.accounts = [unblocked as AccountSlot];
	} else {
		pool.accounts = await recoverAuthBlockedSlots({
			store: pool.store,
			providerId: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
			accounts: pool.accounts,
			signal,
			reload: async () => storedAccounts(await pool.store.read(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID), pool),
			isUsable: (account) => !isBlockedFor(account, activeBoundary.now(), input.model),
			now: activeBoundary.now(),
			transientError: (error) => (error instanceof CredentialStoreBusyError ? error : refreshFailure(error)),
			claudeCliSignedIn: async (slot) => {
				const configDir = accountDirFor(activeBoundary.getAgentDir(), slot.dirId);
				return (await activeBoundary.claudeCliAuthStatus(configDir, pool.environment)).state === "signed_in";
			},
		});
	}
	// A slot that must sign in again is never selected, like a removed one; with none left the turn names them.
	const signedOut = signInRequiredNames(pool.accounts);
	pool.accounts = pool.accounts.filter((account) => account.store !== "claude-cli" || !account.signInRequired);
	if (pool.accounts.length === 0) throw new ClaudeSignInRequiredError(signedOut);
	let askedLegacyLongContext = false;
	yield* runFailover({
		accounts: pool.accounts,
		accountFallback: input.providerSettings.accountFallback,
		selectFn: (accounts) =>
			selectAccount(accounts, {
				sessionId: input.sessionId,
				pinnedAccount: input.pinnedAccount ?? pool.pinnedAccount,
				...(input.pinnedAccount !== undefined
					? { pinSource: "cli" as const }
					: pool.pinSource === undefined
						? {}
						: { pinSource: pool.pinSource }),
				accountFallback: input.providerSettings.accountFallback,
				...(pool.accountOrder === undefined ? {} : { accountOrder: pool.accountOrder }),
				...(input.preferredAccount === undefined ? {} : { preferredAccount: input.preferredAccount }),
				now: activeBoundary.now(),
				...(input.model === undefined ? {} : { model: input.model }),
			}),
		runAttempt: async (slot) => {
			const authLane = laneFor(pool, slot);
			const options = input.buildOptions(authLane);
			askedLegacyLongContext = asksLegacyLongContext(options.model);
			const accounts = pool.accounts.map((account) => ({ ...account }));
			const prepared = slot.store === "claude-cli" ? prepareClaudeCliSlot(pool, slot) : prepareEnvSlot(pool, slot);
			options.env = { ...prepared.env, ...options.env };
			return createAttemptMessages(input, {
				accountName: slot.name,
				accounts,
				authLane,
				pinSource: input.pinnedAccount !== undefined ? "cli" : pool.pinSource,
				options,
				credentialDigest: prepared.credentialDigest,
				...(slot.store === "claude-cli" ? { verifyInitialization: claudeCliInitializationCheck(pool, slot) } : {}),
			});
		},
		classify: (error) => classifyForRequest(error, askedLegacyLongContext),
		...(input.sessionId === undefined ? {} : { sessionKey: input.sessionId }),
		onLongContextRefused: () => markLongContextRefused(),
		store: pool.store,
		providerId: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
		...(input.model === undefined ? {} : { model: input.model }),
		now: activeBoundary.now,
		errorFromEvent: sdkFailure,
		isVisibleDelta: visibleSdkMessage,
		signal,
		...(input.probe === true ? { persistBlocks: false } : {}),
		onFailover: ({ account, nextAccount, classification }) => {
			if (input.probe === true) return;
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
