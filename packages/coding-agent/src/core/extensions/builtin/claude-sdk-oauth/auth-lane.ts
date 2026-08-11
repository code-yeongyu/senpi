import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import { emitProviderAccountFailover, emitProviderAccountsChanged } from "./account-events.ts";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import {
	type AccountSlot,
	assertValidAccountName,
	type ClaudeSdkOauthCredential,
	emptyCredential,
	envSlotToken,
	listAccounts,
	refreshSlot,
	type SlotRefresher,
} from "./accounts.ts";
import { selectAccount } from "./affinity.ts";
import { type AuthenticatedAttemptInput, createAttemptMessages, type RetainableAttempt } from "./auth-attempt.ts";
import { classifySdkError } from "./errors.ts";
import { runFailover } from "./failover.ts";
import type { Options, SDKMessage, SdkQuery } from "./sdk-boundary.ts";
import type { ClaudeSdkOauthProviderSettings, ClaudeSdkOauthTokenInjection } from "./settings.ts";

export { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";

export const EXPIRING_WITHIN_MS = 5 * 60_000;
const CLI_OAUTH_SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
] as const;

type AuthLaneBoundary = {
	createStore: () => CredentialStore;
	env: () => NodeJS.ProcessEnv;
	getAgentDir: () => string;
	now: () => number;
	refresher: SlotRefresher;
};

async function refreshWithAnthropicOAuth(refresh: string) {
	const oauth = await loadAnthropicOAuth();
	const credential = await oauth.refresh({ type: "oauth", access: "", refresh, expires: 0 });
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
	buildOptions: (lane: ClaudeSdkOauthTokenInjection) => Options;
	providerSettings: ClaudeSdkOauthProviderSettings;
	sessionId?: string;
	/** Request-scoped CLI pin; takes precedence over persistent settings and account pins. */
	pinnedAccount?: string;
	onQuery?: (query: ReturnType<SdkQuery>) => void;
	createAttempt?: (
		input: AuthenticatedAttemptInput,
	) => RetainableAttempt<SDKMessage> | Promise<RetainableAttempt<SDKMessage>>;
};

type ManagedPool = {
	accounts: AccountSlot[];
	lane: Exclude<ClaudeSdkOauthTokenInjection, "ambient">;
	pinnedAccount?: string;
	store: CredentialStore;
};

function managedEnvironment(parent: NodeJS.ProcessEnv): Record<string, string | undefined> {
	const {
		ANTHROPIC_API_KEY: _apiKey,
		ANTHROPIC_AUTH_TOKEN: _authToken,
		ANTHROPIC_BASE_URL: _gateway,
		ANTHROPIC_CUSTOM_HEADERS: _customHeaders,
		CLAUDE_CODE_OAUTH_TOKEN: _oauthToken,
		CLAUDE_CODE_USE_BEDROCK: _bedrock,
		CLAUDE_CODE_USE_FOUNDRY: _foundry,
		CLAUDE_CODE_USE_GATEWAY: _gatewayMode,
		CLAUDE_CODE_USE_VERTEX: _vertex,
		...environment
	} = parent;
	for (const name of Object.keys(environment)) {
		if (/^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(name)) delete environment[name];
		if (name.startsWith("SENPI_")) delete environment[name];
	}
	return environment;
}

function configDirectory(slot: AccountSlot): string {
	assertValidAccountName(slot.name);
	return join(activeBoundary.getAgentDir(), "claude-sdk-oauth-accounts", slot.name);
}

function writeConfigCredentials(directory: string, slot: AccountSlot, access: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	writeFileSync(
		join(directory, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: access,
				refreshToken: slot.refresh,
				expiresAt: slot.expires,
				scopes: CLI_OAUTH_SCOPES,
			},
		}),
		{ encoding: "utf8", mode: 0o600 },
	);
}

async function managedPool(settings: ClaudeSdkOauthProviderSettings): Promise<ManagedPool | undefined> {
	const lane = settings.tokenInjection ?? "oauth-slots";
	if (lane === "ambient") return undefined;
	const store = activeBoundary.createStore();
	let credential = await store.read(CLAUDE_SDK_OAUTH_PROVIDER_ID);
	const environment = activeBoundary.env();
	let accounts = listAccounts(
		(credential as ClaudeSdkOauthCredential | undefined) ?? emptyCredential(),
		(name) => environment[name],
	);
	if (!credential && accounts.length > 0) {
		credential = await store.modify(CLAUDE_SDK_OAUTH_PROVIDER_ID, async () => emptyCredential());
		accounts = listAccounts(
			(credential as ClaudeSdkOauthCredential) ?? emptyCredential(),
			(name) => environment[name],
		);
	}
	if (accounts.length === 0) return undefined;
	const stored = credential?.type === "oauth" ? (credential as ClaudeSdkOauthCredential) : undefined;
	return { accounts, lane, pinnedAccount: settings.pinnedAccount ?? stored?.pinned, store };
}

async function prepareSlot(pool: ManagedPool, selected: AccountSlot): Promise<Record<string, string | undefined>> {
	const environment = activeBoundary.env();
	const slot = selected;
	if (slot.source !== "env" && activeBoundary.now() >= slot.expires - EXPIRING_WITHIN_MS) {
		try {
			const refreshed = await refreshSlot(
				pool.store,
				CLAUDE_SDK_OAUTH_PROVIDER_ID,
				slot.name,
				activeBoundary.refresher,
				(expires) => activeBoundary.now() >= expires - EXPIRING_WITHIN_MS,
			);
			const credential = refreshed?.type === "oauth" ? (refreshed as ClaudeSdkOauthCredential) : undefined;
			const updated = listAccounts(credential ?? emptyCredential(), (name) => environment[name]).find(
				(candidate) => candidate.name === slot.name,
			);
			if (!updated) throw new Error("selected account disappeared during refresh");
			Object.assign(slot, updated);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`authentication_failed: ${detail}`);
		}
	}
	const access = slot.source === "env" ? envSlotToken((name) => environment[name], slot.name) : slot.access;
	if (!access) throw new Error("authentication_failed: selected OAuth token is unavailable");
	const childEnvironment = managedEnvironment(environment);
	if (pool.lane === "oauth-slots") return { ...childEnvironment, CLAUDE_CODE_OAUTH_TOKEN: access };
	const directory = configDirectory(slot);
	writeConfigCredentials(directory, slot, access);
	return { ...childEnvironment, CLAUDE_CONFIG_DIR: directory };
}

function sdkFailure(message: SDKMessage): unknown | undefined {
	if (message.type === "assistant" && message.error) return message.error;
	if (message.type === "result" && message.subtype !== "success") {
		const errors = "errors" in message && Array.isArray(message.errors) ? (message.errors as unknown[]) : [];
		if (errors.length > 0) return new Error(String(errors[0]));
		// `subtype` alone is too coarse to classify: a subscription limit and an
		// ordinary tool failure both arrive as "error_during_execution". The SDK
		// carries the real cause in `terminal_reason` (e.g. "blocking_limit"), so
		// append it — otherwise classifySdkError() scores every result error as
		// non-retryable "other", the exhausted account is never blocked, and a
		// multi-account pool never rotates past it.
		const reason =
			"terminal_reason" in message && typeof message.terminal_reason === "string" ? message.terminal_reason : "";
		return new Error(reason ? `Claude Code ${message.subtype}: ${reason}` : `Claude Code ${message.subtype}`);
	}
	return undefined;
}

function visibleSdkMessage(message: SDKMessage): boolean {
	if (message.type !== "stream_event") return false;
	return /^(?:content_block_start|content_block_delta|content_block_stop)$/.test(message.event.type);
}

/** Resolves managed OAuth immediately before each subprocess spawn and retries only pre-delta failures. */
export async function* queryWithAuthLane(input: AuthenticatedQueryInput): AsyncGenerator<SDKMessage> {
	const pool = await managedPool(input.providerSettings);
	if (!pool) {
		const options = input.buildOptions("ambient");
		const parentEnvironment = activeBoundary.env();
		const ambientEnvironment: Record<string, string | undefined> = { ...parentEnvironment };
		for (const name of Object.keys(ambientEnvironment)) {
			if (name.startsWith("SENPI_")) delete ambientEnvironment[name];
		}
		options.env = ambientEnvironment;
		yield* await createAttemptMessages(input, {
			accountName: "ambient",
			accounts: [],
			authLane: "ambient",
			options,
		});
		return;
	}
	yield* runFailover({
		accounts: pool.accounts,
		selectFn: (accounts) =>
			selectAccount(accounts, {
				sessionId: input.sessionId,
				pinnedAccount: input.pinnedAccount ?? pool.pinnedAccount,
				now: activeBoundary.now(),
			}),
		runAttempt: async (slot) => {
			const options = input.buildOptions(pool.lane);
			const accounts = pool.accounts.map((account) => ({ ...account }));
			options.env = await prepareSlot(pool, slot);
			return createAttemptMessages(input, {
				accountName: slot.name,
				accounts,
				authLane: pool.lane,
				options,
			});
		},
		classify: classifySdkError,
		store: pool.store,
		providerId: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		now: activeBoundary.now,
		errorFromEvent: sdkFailure,
		isVisibleDelta: visibleSdkMessage,
		onFailover: ({ account, nextAccount, classification }) => {
			emitProviderAccountsChanged(CLAUDE_SDK_OAUTH_PROVIDER_ID);
			if (nextAccount) {
				emitProviderAccountFailover(
					CLAUDE_SDK_OAUTH_PROVIDER_ID,
					account.name,
					nextAccount.name,
					classification.kind,
				);
			}
		},
	});
}
