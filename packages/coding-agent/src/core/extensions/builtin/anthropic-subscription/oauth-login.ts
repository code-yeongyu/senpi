import type {
	AuthCheck,
	AuthContext,
	AuthResult,
	CredentialStore,
	OAuthCredential,
	OAuthCredentials,
} from "@earendil-works/pi-ai";
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	assertValidAccountName,
	type ClaudeCliAccountCheck,
	type ClaudeCliAccountSlot,
	emptyCredential,
	isListedStoredSlot,
	listAccounts,
	SENTINEL_OAUTH_FIELDS,
} from "./accounts.ts";
import { activeBoundary } from "./auth-lane-boundary.ts";
import { readAmbientClaudeAuthStatus } from "./availability.ts";
import {
	accountDirFor,
	CLAUDE_CLI_SHARED_LINKS,
	claudeCliSharedRoot,
	ensureAccountDir,
	newAccountDirId,
	removeAccountDir,
} from "./claude-cli-account-dir.ts";
import {
	type ClaudeCliLogin,
	type ClaudeCliLoginMethod,
	type ClaudeCliLoginResult,
	startClaudeCliLogin,
} from "./claude-cli-auth.ts";
import { type ClaudeCliAuthStatus, logoutClaudeCli, readClaudeCliAuthStatus } from "./claude-cli-auth-status.ts";
import {
	type ClaudeCliConnectionTestInput,
	connectionTestModel,
	type DefaultModelSelection,
	runClaudeCliConnectionTest,
} from "./claude-cli-connection-test.ts";
import { recordClaudeCliLoginOutcome } from "./claude-cli-login-outcome.ts";
import type { ClaudeCliRun } from "./claude-cli-process.ts";
import { signedInSlot, storedSubscription, withCheck, withoutThisLogin, withSlot } from "./claude-cli-login-slots.ts";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";
import type { AnthropicSubscriptionProviderSettings } from "./settings.ts";

export type OAuthLoginCallbacks = {
	signal?: AbortSignal;
	onAuth?: (event: { url: string; instructions?: string }) => void | Promise<void>;
	onPrompt?: (prompt: { message: string; placeholder?: string; signal?: AbortSignal }) => Promise<string>;
	onSelect?: (prompt: {
		message: string;
		options: readonly { id: string; label: string }[];
		signal?: AbortSignal;
	}) => Promise<string | undefined>;
	onManualCodeInput?: () => Promise<string>;
	onProgress?: (message: string) => void;
};

/** The method select the desktop and remote clients answer by these exact labels. */
export const ANTHROPIC_LOGIN_METHOD_PROMPT = {
	message: "Select Anthropic login method:",
	options: [
		{ id: "browser", label: "Browser login (default)" },
		{ id: "copy_code", label: "Copy code login (headless)" },
	],
} as const;

/** The paste prompt's title; its placeholder carries the manual sign-in URL ("Get a code instead"). */
const ANTHROPIC_PASTE_CODE_MESSAGE = "Paste the code Anthropic shows after you sign in:";

/** Everything the CLI sign-in touches, injectable for tests; defaults are the turn path's own boundary. */
export type ClaudeCliLoginDeps = {
	agentDir?: () => string;
	env?: () => NodeJS.ProcessEnv;
	store?: () => CredentialStore;
	executable?: (env: NodeJS.ProcessEnv) => string;
	defaultModel?: () => DefaultModelSelection | undefined;
	providerSettings?: () => AnthropicSubscriptionProviderSettings;
	cwd?: () => string;
	connectionTest?: (input: ClaudeCliConnectionTestInput) => Promise<ClaudeCliAccountCheck>;
	authStatus?: (run: ClaudeCliRun) => Promise<ClaudeCliAuthStatus>;
	now?: () => number;
};

export type CurrentCredentialReader = () => Promise<AnthropicSubscriptionCredential | undefined>;

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

export const ANTHROPIC_SUBSCRIPTION_NAME = "Anthropic Subscription (Claude Pro/Max)";
const ENV_TOKEN_NAMES = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	...Array.from({ length: 15 }, (_, index) => `CLAUDE_CODE_OAUTH_TOKEN_${index + 2}`),
] as const;
const ENV_TOKEN_NAME_SET = new Set<string>(ENV_TOKEN_NAMES);
const AUTH_CHECK = { source: "Anthropic Subscription", type: "oauth" } as const;

function requestClaudeEnvironment(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const environment: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (ENV_TOKEN_NAME_SET.has(name) && typeof entry === "string") environment[name] = entry;
	}
	return environment;
}

/** A blank answer adds a new account; typing an existing name signs that account in again. */
async function promptAccountName(callbacks: OAuthLoginCallbacks, existing: AccountSlot[]): Promise<string> {
	if (existing.length === 0) return "default";
	let next = existing.length + 1;
	while (existing.some((slot) => slot.name === `account-${next}`)) next++;
	const fallback = `account-${next}`;
	if (!callbacks.onPrompt) return fallback;
	const names = existing.map((slot) => slot.name).join(", ");
	const answer = (
		await callbacks.onPrompt({
			message: `Name for this account (existing: ${names}; press Enter to add ${fallback}, or type an existing name to refresh it)`,
			placeholder: fallback,
		})
	).trim();
	return answer || fallback;
}

/** Removes a new account dir that holds no login (a cancelled or failed first sign-in), never following its links. */
function discardAccountDir(agentDir: string, dirId: string): void {
	const accountDir = accountDirFor(agentDir, dirId);
	for (const entry of CLAUDE_CLI_SHARED_LINKS) {
		const path = join(accountDir, entry);
		try {
			if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
		} catch {
			// absent entry: nothing to unlink
		}
	}
	rmSync(accountDir, { recursive: true, force: true });
}

async function selectLoginMethod(callbacks: OAuthLoginCallbacks): Promise<ClaudeCliLoginMethod> {
	if (!callbacks.onSelect) return "browser";
	const answer = await callbacks.onSelect({
		...ANTHROPIC_LOGIN_METHOD_PROMPT,
		...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
	});
	if (answer === undefined) throw new Error("Login cancelled");
	return answer === "copy_code" ? "copy-code" : "browser";
}

const LOGIN_FAILURE_MESSAGES: Record<Exclude<ClaudeCliLoginResult, { outcome: "success" }>["outcome"], string> = {
	cancelled: "Login cancelled",
	timeout: "Claude sign-in timed out without a browser callback or a pasted code. Run the login again.",
	failed: "Claude sign-in failed",
};

function loginFailure(result: Exclude<ClaudeCliLoginResult, { outcome: "success" }>): Error {
	if (result.outcome !== "failed") return new Error(LOGIN_FAILURE_MESSAGES[result.outcome]);
	if (result.reason === "org_not_allowed")
		return new Error("Claude sign-in failed: your organization does not allow it");
	if (result.reason === "spawn_failed") return new Error("Claude sign-in failed: the Claude Code CLI could not start");
	return new Error(`${LOGIN_FAILURE_MESSAGES.failed} (${result.reason})`);
}

/**
 * Runs `claude auth login --claudeai` for one account dir. The auth URL goes to `onAuth` (the captured browser URL,
 * or the manual URL in copy-code mode), and a paste prompt carrying the manual URL feeds codes to the CLI's stdin
 * until the login settles. Output, URLs and codes are never logged.
 */
async function signInThroughCli(
	run: ClaudeCliRun,
	method: ClaudeCliLoginMethod,
	callbacks: OAuthLoginCallbacks,
): Promise<void> {
	const pasteAbort = new AbortController();
	const loginAbort = new AbortController();
	let pasteError: unknown;
	let settled = false;
	let login: ClaudeCliLogin | undefined;
	const pasteCodes = async (manualUrl: string) => {
		if (!callbacks.onPrompt) return;
		try {
			while (!settled) {
				const answer = await callbacks.onPrompt({
					message: ANTHROPIC_PASTE_CODE_MESSAGE,
					placeholder: manualUrl,
					signal: pasteAbort.signal,
				});
				// A blank answer pastes nothing: the login keeps waiting for the browser callback.
				if (settled || answer.trim() === "" || login?.submitCode(answer)) return;
			}
		} catch (error) {
			if (settled) return;
			pasteError = error;
			loginAbort.abort();
		}
	};
	login = startClaudeCliLogin({
		...run,
		method,
		signal:
			callbacks.signal === undefined ? loginAbort.signal : AbortSignal.any([callbacks.signal, loginAbort.signal]),
		onAutomaticUrl: (url) => {
			if (method === "browser") void callbacks.onAuth?.({ url });
		},
		onManualUrl: (url) => {
			if (method === "copy-code") void callbacks.onAuth?.({ url });
			void pasteCodes(url);
		},
	});
	let result: ClaudeCliLoginResult;
	try {
		result = await login.result;
	} finally {
		settled = true;
		pasteAbort.abort();
	}
	if (result.outcome === "success") return;
	if (result.outcome === "cancelled" && pasteError !== undefined) {
		throw pasteError instanceof Error ? pasteError : new Error(String(pasteError));
	}
	throw loginFailure(result);
}

export function createOAuthConfig(deps: {
	readCurrent: CurrentCredentialReader;
	readAmbientAuthStatus?: (signal?: AbortSignal) => Promise<boolean>;
	readSettings?: () => { tokenInjection?: "oauth-slots" | "config-dir" | "ambient"; enabled?: boolean } | undefined;
	claudeCli?: ClaudeCliLoginDeps;
}): OAuthConfigShape {
	const cli = deps.claudeCli ?? {};
	const agentDir = () => (cli.agentDir ?? activeBoundary.getAgentDir)();
	const hostEnv = () => (cli.env ?? activeBoundary.env)();
	const store = () => (cli.store ?? activeBoundary.createStore)();
	const now = () => (cli.now ?? activeBoundary.now)();
	const executableFor = (env: NodeJS.ProcessEnv) =>
		cli.executable
			? cli.executable(env)
			: resolveClaudeCodeExecutable({ ...defaultExecutableDeps(), env: (key) => env[key] });

	const claudeEnvironment = async (ctx: AuthContext): Promise<Record<string, string>> => {
		const entries = await Promise.all(ENV_TOKEN_NAMES.map(async (name) => [name, await ctx.env(name)] as const));
		return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
	};

	/** Single predicate behind both `check` and `resolveAmbient`, so availability and resolution cannot disagree. */
	const configuredFor = async (
		ctx: AuthContext,
		stored: AnthropicSubscriptionCredential | undefined,
		signal?: AbortSignal,
		environment?: Record<string, string>,
	): Promise<boolean> => {
		// Only the accounts the lane lists count, exactly as `listAccounts` lists them: a hidden token-holding slot, or a
		// flat credential whose top-level tokens are real (a legacy login, or a token slot projected by slot-scoped
		// resolution; a Claude CLI slot projects to nothing), must not make the provider configured and then fail every
		// turn with no account to serve (senpi#4436).
		const storedAccounts =
			stored?.type === "oauth" && Array.isArray(stored.accounts) ? stored.accounts.filter(isListedStoredSlot) : [];
		const effectiveEnvironment = environment ?? (await claudeEnvironment(ctx));
		const environmentTokenCount = Object.values(effectiveEnvironment).filter(Boolean).length;
		const accountCount = storedAccounts.length + environmentTokenCount;
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
		name: ANTHROPIC_SUBSCRIPTION_NAME,

		async check({ ctx, credential, signal }) {
			const requestEnvironment = requestClaudeEnvironment(credential?.env);
			return (await configuredFor(
				ctx,
				credential as AnthropicSubscriptionCredential | undefined,
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
			const name = await promptAccountName(callbacks, existing);
			assertValidAccountName(name);
			const method = await selectLoginMethod(callbacks);
			// A login cancelled while provider_login_start handlers ran (or at a prompt) never spawns the CLI.
			if (callbacks.signal?.aborted) throw new Error("Login cancelled");

			const env = hostEnv();
			const executable = executableFor(env);
			// A re-login signs into a fresh dir and takes the account over only once it succeeded, so a cancel or error
			// can never leave the existing account's dir holding a different login. The slot it replaces is read under
			// the lock of that write, so the dir it retires and the fields an undo restores are the ones it replaced.
			let previous: AccountSlot | undefined;
			const dirId = newAccountDirId();
			const configDir = ensureAccountDir({ agentDir: agentDir(), dirId, sharedRoot: claudeCliSharedRoot(env) });
			const run: ClaudeCliRun = { executable, configDir, parentEnv: env };
			const credentials = store();
			const cancelled = () => {
				if (callbacks.signal?.aborted) throw new Error("Login cancelled");
			};
			let loginStarted = false;
			let loginSaved = false;
			let signedInCredential: AnthropicSubscriptionCredential;
			let written: ClaudeCliAccountSlot | undefined;
			// One guarded step from the moment the dir exists to the end of login(): any throw or cancel undoes it all.
			// The slot this login wrote is taken back (removed for a new account; for a re-login only the fields this
			// login changed and nobody changed since are restored, re-read under the lock), the fresh dir is signed out
			// whenever its CLI login was started (it may have saved a login before the step failed), and the fresh dir is
			// removed. Past the last step the slot stays written, so no signed-in dir is ever left without the slot that
			// owns it, even when the caller's commit (Models.login / AuthStorage.set) is cancelled or fails.
			const rollBack = async () => {
				const ours = written;
				if (ours !== undefined) {
					await credentials.modify(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, async (stored) => {
						const base = storedSubscription(stored);
						if (base === undefined) return stored;
						return { ...base, accounts: withoutThisLogin(base.accounts ?? [], ours, previous) };
					});
				}
				if (loginStarted) {
					const signedOut = await logoutClaudeCli(run).catch(() => false);
					// Before the CLI reported success it may have saved nothing, and logout also fails when there is nothing
					// to sign out, so only a finished CLI login is reported as a login that could not be signed out.
					if (!signedOut)
						callbacks.onProgress?.(
							loginSaved
								? "Claude sign-in was undone, but the Claude login it made could not be signed out (claude auth logout failed); its account dir was removed"
								: "Claude sign-in was undone and its account dir was removed; claude auth logout failed, so a Claude login the CLI may have saved before it stopped is not confirmed signed out",
						);
				}
				discardAccountDir(agentDir(), dirId);
			};
			try {
				loginStarted = true;
				await signInThroughCli(run, method, callbacks);
				loginSaved = true;
				const status = await (cli.authStatus ?? readClaudeCliAuthStatus)(run);
				cancelled();
				if (status.state !== "signed_in") {
					throw new Error(
						status.state === "rejected"
							? "Claude sign-in did not produce a Claude subscription login (Pro/Max); sign in with your claude.ai account"
							: "Claude sign-in finished, but Claude Code reports no login for this account",
					);
				}

				const signedInAt = now();
				const claimed: { slot?: ClaudeCliAccountSlot } = {};
				await credentials.modify(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, async (stored) => {
					const base = storedSubscription(stored) ?? current;
					previous = base.accounts?.find((candidate) => candidate.name === name);
					claimed.slot = signedInSlot(previous, name, dirId, status.profile, signedInAt);
					written = claimed.slot;
					return withSlot(base, claimed.slot);
				});
				const slot = claimed.slot;
				if (slot === undefined) throw new Error("Claude sign-in could not store its account");
				cancelled();
				const model = connectionTestModel(cli.defaultModel?.());
				callbacks.onProgress?.(`Testing the account with one turn on ${model}...`);
				const check = await (cli.connectionTest ?? runClaudeCliConnectionTest)({
					name,
					model,
					executable,
					cwd: cli.cwd?.() ?? process.cwd(),
					providerSettings: cli.providerSettings?.() ?? {},
					...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
					now,
				});
				// A test cut short by a cancel is a cancelled login, never a kept account with a failed check.
				cancelled();
				callbacks.onProgress?.(
					check.outcome === "ok"
						? `Connection test passed on ${model}`
						: `Connection test failed on ${model} (${check.reason ?? "unknown"}); the account was kept. Retry from the account list.`,
				);
				// The slot stays written: the caller's commit merges onto it, so the account owns its dir throughout.
				let tested: AccountSlot = slot;
				const saved = await credentials.modify(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, async (stored) => {
					const base = storedSubscription(stored) ?? withSlot(current, slot);
					tested = base.accounts?.find((candidate) => candidate.name === name) ?? slot;
					return withCheck(base, name, check);
				});
				if (callbacks.signal !== undefined)
					recordClaudeCliLoginOutcome(callbacks.signal, { account: { name }, check });
				signedInCredential = withCheck(withSlot(storedSubscription(saved) ?? current, tested), name, check);
			} catch (error) {
				try {
					await rollBack();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Claude sign-in failed and its cleanup failed too");
				}
				throw error;
			}
			const retiring = previous?.store === "claude-cli" ? previous : undefined;
			if (retiring !== undefined) {
				// The account now lives in the fresh dir: the old dir's login is signed out and the dir removed.
				const retired = await removeAccountDir({
					agentDir: agentDir(),
					dirId: retiring.dirId,
					executable,
					parentEnv: env,
				}).catch((error: unknown) => {
					callbacks.onProgress?.(
						`Signed in, but the previous Claude account dir could not be removed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return undefined;
				});
				if (retired === "removed_without_sign_out")
					callbacks.onProgress?.(
						"Signed in; the previous Claude login could not be signed out, its dir was removed",
					);
			}
			return signedInCredential;
		},

		async refreshToken(credentials) {
			return credentials;
		},

		getApiKey(_credentials) {
			return SENTINEL_OAUTH_FIELDS.access;
		},
	};
}
