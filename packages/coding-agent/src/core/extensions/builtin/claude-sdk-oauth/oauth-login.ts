import type {
	AuthCheck,
	AuthContext,
	AuthResult,
	OAuthAuth,
	OAuthCredential,
	OAuthCredentials,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import {
	type AccountSlot,
	addAccount,
	type ClaudeSdkOauthCredential,
	emptyCredential,
	listAccounts,
	SENTINEL_OAUTH_FIELDS,
	upsertAccount,
} from "./accounts.ts";
import { readAmbientClaudeAuthStatus } from "./availability.ts";

export type OAuthLoginCallbacks = {
	signal?: AbortSignal;
	onAuth?: (event: { url: string }) => void | Promise<void>;
	onPrompt?: (prompt: { message: string; placeholder?: string; signal?: AbortSignal }) => Promise<string>;
	onManualCodeInput?: () => Promise<string>;
	onProgress?: (message: string) => void;
};

export type CurrentCredentialReader = () => Promise<ClaudeSdkOauthCredential | undefined>;

export type OAuthConfigShape = {
	name: string;
	check(input: {
		ctx: AuthContext;
		credential?: OAuthCredential;
		signal?: AbortSignal;
	}): Promise<AuthCheck | undefined>;
	/**
	 * Request auth for the ambient lane — an environment OAuth token or a
	 * logged-in Claude CLI — used when auth.json holds no managed accounts.
	 * The SDK subprocess authenticates itself in that lane, so the sentinel is
	 * the whole credential; without this the provider passes `check` and then
	 * fails every request with "Provider is not configured".
	 */
	resolveAmbient(input: {
		ctx: AuthContext;
		env?: Record<string, string>;
		signal?: AbortSignal;
	}): Promise<AuthResult | undefined>;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

export const CLAUDE_SDK_OAUTH_NAME = "Claude SDK OAuth (Claude Pro/Max)";
const ENV_TOKEN_NAMES = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	...Array.from({ length: 15 }, (_, index) => `CLAUDE_CODE_OAUTH_TOKEN_${index + 2}`),
] as const;
const ENV_TOKEN_NAME_SET = new Set<string>(ENV_TOKEN_NAMES);
const AUTH_CHECK = { source: "Claude SDK OAuth", type: "oauth" } as const;

function requestClaudeEnvironment(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const environment: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (ENV_TOKEN_NAME_SET.has(name) && typeof entry === "string") environment[name] = entry;
	}
	return environment;
}

function toSlot(
	credential: { access: string; refresh: string; expires: number },
	name: string,
	source: AccountSlot["source"],
): AccountSlot {
	return { name, access: credential.access, refresh: credential.refresh, expires: credential.expires, source };
}

/**
 * Recovery target for a re-login (omo#7084): a lone slot, or the pool's one
 * auth-blocked slot, is refreshed in place — identity-safe because no working
 * account is displaced. Anything else stays append-only unless the user names
 * an existing slot explicitly, so a blank or headless re-login never
 * overwrites the newest working slot in a multi-account pool.
 */
function recoveryTargetName(existing: AccountSlot[]): string | undefined {
	if (existing.length === 1) return existing[0]?.name;
	const authBlocked = existing.filter((slot) => slot.blockReason === "auth_error");
	if (authBlocked.length === 1) return authBlocked[0]?.name;
	return undefined;
}

async function promptAccountName(callbacks: OAuthLoginCallbacks, existing: AccountSlot[]): Promise<string> {
	if (existing.length === 0) return "default";
	const recovery = recoveryTargetName(existing);
	const fallback = `account-${existing.length + 1}`;
	if (!callbacks.onPrompt) return recovery ?? fallback;
	const names = existing.map((slot) => slot.name).join(", ");
	const message =
		recovery === undefined
			? `Name for this account (existing: ${names}; press Enter to add ${fallback}, or type an existing name to refresh it)`
			: `Name for this account (existing: ${names}; press Enter to refresh '${recovery}' with this login)`;
	const answer = (
		await callbacks.onPrompt({
			message,
			placeholder: recovery ?? fallback,
		})
	).trim();
	return answer || recovery || fallback;
}

export function createOAuthConfig(deps: {
	readCurrent: CurrentCredentialReader;
	readAnthropicCredential?: () => Promise<{ access: string; refresh: string; expires: number } | undefined>;
	/** Moves the imported grant out of the anthropic provider so two stores never refresh one single-use token (omo#7084). */
	removeAnthropicCredential?: () => Promise<void>;
	readAmbientAuthStatus?: (signal?: AbortSignal) => Promise<boolean>;
	readSettings?: () => { tokenInjection?: "oauth-slots" | "config-dir" | "ambient"; enabled?: boolean } | undefined;
	loginFlow?: OAuthAuth;
}): OAuthConfigShape {
	const claudeEnvironment = async (ctx: AuthContext): Promise<Record<string, string>> => {
		const entries = await Promise.all(ENV_TOKEN_NAMES.map(async (name) => [name, await ctx.env(name)] as const));
		return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
	};

	/** Single predicate behind both `check` and `resolveAmbient`, so availability and resolution cannot disagree. */
	const configuredFor = async (
		ctx: AuthContext,
		stored: ClaudeSdkOauthCredential | undefined,
		signal?: AbortSignal,
		environment?: Record<string, string>,
	): Promise<boolean> => {
		const storedAccounts = stored?.type === "oauth" && Array.isArray(stored.accounts) ? stored.accounts : [];
		// Slot-scoped resolution projects one account onto the flat credential shape,
		// stripping `accounts`; its concrete (non-sentinel) tokens are that account.
		const selectedStoredAccount =
			stored?.type === "oauth" &&
			stored.access !== SENTINEL_OAUTH_FIELDS.access &&
			stored.refresh !== SENTINEL_OAUTH_FIELDS.refresh;
		const effectiveEnvironment = environment ?? (await claudeEnvironment(ctx));
		const environmentTokenCount = Object.values(effectiveEnvironment).filter(Boolean).length;
		const accountCount = storedAccounts.length + (selectedStoredAccount ? 1 : 0) + environmentTokenCount;
		const settings = deps.readSettings?.();
		const lane = settings?.tokenInjection ?? (accountCount > 0 ? "oauth-slots" : "ambient");
		if (lane === "ambient") {
			if (environmentTokenCount > 0) return true;
			// A logged-in host Claude CLI is not senpi-side consent: spending the
			// user's Claude subscription requires an explicit opt-in. Stored
			// accounts and env tokens above are opt-ins in themselves.
			if (settings?.enabled !== true) return false;
			return (deps.readAmbientAuthStatus ?? readAmbientClaudeAuthStatus)(signal);
		}
		return accountCount > 0;
	};

	return {
		name: CLAUDE_SDK_OAUTH_NAME,

		async check({ ctx, credential, signal }) {
			const requestEnvironment = requestClaudeEnvironment(credential?.env);
			return (await configuredFor(
				ctx,
				credential as ClaudeSdkOauthCredential | undefined,
				signal,
				Object.keys(requestEnvironment).length > 0 ? requestEnvironment : undefined,
			))
				? AUTH_CHECK
				: undefined;
		},

		async resolveAmbient({ ctx, env, signal }) {
			const requestEnvironment = requestClaudeEnvironment(env);
			const environment =
				Object.keys(requestEnvironment).length > 0 ? requestEnvironment : await claudeEnvironment(ctx);
			if (!(await configuredFor(ctx, undefined, signal, environment))) return undefined;
			return {
				auth: { apiKey: SENTINEL_OAUTH_FIELDS.access },
				...(Object.keys(environment).length > 0 ? { env: environment } : {}),
				source: AUTH_CHECK.source,
			};
		},

		async login(callbacks) {
			const current = (await deps.readCurrent()) ?? emptyCredential();
			const existing = listAccounts(current);
			if (existing.length === 0 && deps.readAnthropicCredential && callbacks.onPrompt) {
				const imported = await deps.readAnthropicCredential();
				if (imported) {
					const answer = (
						await callbacks.onPrompt({
							message:
								"An Anthropic OAuth login already exists. Move it here (the anthropic provider is logged out) instead of a new login? [y/N]",
						})
					)
						.trim()
						.toLowerCase();
					if (answer === "y" || answer === "yes") {
						await deps.removeAnthropicCredential?.();
						return addAccount(current, toSlot(imported, "imported-anthropic", "import"));
					}
				}
			}
			const interaction: ProviderAuthInteraction = {
				signal: callbacks.signal ?? new AbortController().signal,
				prompt: async (prompt) => {
					if (prompt.type === "select") return "";
					return callbacks.onPrompt ? callbacks.onPrompt(prompt) : "";
				},
				notify: (event) => {
					if (event.type === "auth_url" && callbacks.onAuth) void callbacks.onAuth({ url: event.url });
					if (event.type === "progress" && callbacks.onProgress) callbacks.onProgress(event.message);
				},
			};
			const flow = deps.loginFlow ?? (await loadAnthropicOAuth());
			const credential = await flow.login(interaction);

			const existingAfter = listAccounts(current);
			const name = await promptAccountName(callbacks, existingAfter);
			return upsertAccount(current, toSlot(credential, name, "login"));
		},

		async refreshToken(credentials) {
			return credentials;
		},

		getApiKey(_credentials) {
			return SENTINEL_OAUTH_FIELDS.access;
		},
	};
}
