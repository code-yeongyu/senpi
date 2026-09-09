import { execFile as nodeExecFile } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AuthCheck,
	AuthContext,
	Credential,
	OAuthAuth,
	OAuthCredential,
	OAuthCredentials,
	OAuthLoginCallbacks,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { cursorProvider } from "@earendil-works/pi-ai/providers/cursor";
import {
	addAccount,
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
	listAccounts,
	SENTINEL_OAUTH_FIELDS,
} from "./accounts.ts";
import {
	type CursorAgentExecutableDeps,
	defaultCursorAgentExecutableDeps,
	resolveCursorAgentExecutable,
} from "./executable.ts";
import { CURSOR_CLI_OAUTH_NO_APPROVAL_EXPLANATION } from "./guardrails.ts";
import {
	type CursorCliOauthProviderSettings,
	loadCursorCliOauthProviderSettingsFromDisk,
	persistCursorCliNoApprovalAcknowledgement,
	persistCursorCliOauthEnabled,
} from "./settings.ts";

export const CURSOR_CLI_OAUTH_PROVIDER_ID = "cursor-cli-oauth";
export const CURSOR_CLI_OAUTH_NAME = "Cursor CLI (OAuth)";

const NO_ACCOUNTS_MESSAGE = "no accounts: run /login cursor-cli-oauth";
const DISABLED_MESSAGE = "disabled by settings";
const FILE_STORE_LANE = "file-store" as const;
const DEFAULT_IMPORTED_EXPIRY_MS = 60 * 60 * 1000;

type CursorCliOauthSettings = Pick<CursorCliOauthProviderSettings, "enabled" | "executablePath"> &
	Partial<Pick<CursorCliOauthProviderSettings, "explicitlyDisabled">>;

/**
 * The opt-in rule, in one place so availability, turn-time resolution, and the
 * host-derived bootstrap gate cannot disagree.
 *
 * - `enabled: false` written verbatim in settings or the environment is a kill
 *   switch: the lane is off regardless of what is stored.
 * - Otherwise the flag gates only the host-CLI-derived opt-in. Stored senpi account slots
 *   exist only because the user ran `/login cursor-cli-oauth` or
 *   `/cursor-account import`, and that explicit action IS the opt-in.
 */
export function isCursorCliOauthLaneEnabled(settings: CursorCliOauthSettings, storedAccountCount: number): boolean {
	if (settings.explicitlyDisabled === true) return false;
	return settings.enabled || storedAccountCount > 0;
}

type ImportedCursorCredential = {
	access: string;
	refresh: string;
	expires?: number;
};

export type CursorCliOauthConfigDeps = {
	readCurrent: () => Promise<Credential | undefined>;
	readSettings: () => CursorCliOauthSettings;
	resolveExecutable: (settings: CursorCliOauthSettings) => string;
	loadOAuth?: () => Promise<OAuthAuth>;
	readCursorFile?: () => Promise<ImportedCursorCredential | undefined>;
	readCursorKeychain?: () => Promise<ImportedCursorCredential | undefined>;
	/** Clock for acknowledgement timestamps; injectable so tests stay deterministic. */
	now?: () => Date;
	/** Persists the no-approval acknowledgement; the disk default is wired in defaultCursorCliOauthConfig. */
	persistAcknowledgement?: (acknowledgedAt: string) => void;
	/** Persists explicit provider activation after a successful login. */
	persistEnabled?: (enabled: boolean) => void;
};

export type CursorCliOauthLaneResolution = {
	lane: typeof FILE_STORE_LANE;
	account: CursorCliAccountSlot;
	accounts: CursorCliAccountSlot[];
};

export type CursorCliOauthConfig = {
	name: string;
	isSubscription: true;
	check(input: {
		ctx: AuthContext;
		credential?: OAuthCredential;
		signal?: AbortSignal;
	}): Promise<AuthCheck | undefined>;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

export type LocalCursorImportDeps = {
	platform?: NodeJS.Platform;
	readCursorFile?: () => Promise<ImportedCursorCredential | undefined>;
	readCursorKeychain?: () => Promise<ImportedCursorCredential | undefined>;
	onPrompt?: OAuthLoginCallbacks["onPrompt"];
};

type ConfigurationAssessment = {
	accounts: CursorCliAccountSlot[];
	message: string;
};

/** The single condition evaluation behind both the tolerant `check` and the throwing turn-time resolution. */
type ConfigurationOutcome =
	| { status: "disabled" }
	| { status: "not-installed"; error: unknown }
	| { status: "no-accounts" }
	| { status: "configured"; assessment: ConfigurationAssessment };

/**
 * One predicate so availability and resolution cannot disagree: evaluates the
 * same conditions for every caller and reports why the lane is unusable
 * instead of deciding per call-site whether that is fatal.
 */
async function assessConfiguration(deps: CursorCliOauthConfigDeps): Promise<ConfigurationOutcome> {
	const settings = deps.readSettings();
	if (settings.explicitlyDisabled === true) return { status: "disabled" };
	try {
		deps.resolveExecutable(settings);
	} catch (error) {
		return { status: "not-installed", error };
	}

	// Read the stored slots before applying the flag: an explicit senpi-side login
	// is itself the opt-in, so only the flagless host-derived shape reports disabled.
	const accounts = usableAccounts(await deps.readCurrent());
	if (!isCursorCliOauthLaneEnabled(settings, accounts.length)) return { status: "disabled" };
	if (accounts.length === 0) return { status: "no-accounts" };
	return {
		status: "configured",
		assessment: { accounts, message: `configured (file-store, ${accounts.length} accounts)` },
	};
}

/** The throwing view used by turn-time resolution; a turn attempted on an unusable lane must still error clearly. */
async function configuredFor(deps: CursorCliOauthConfigDeps): Promise<ConfigurationAssessment> {
	const outcome = await assessConfiguration(deps);
	switch (outcome.status) {
		case "disabled":
			throw new Error(DISABLED_MESSAGE);
		case "not-installed":
			throw cursorAgentNotInstalledError(outcome.error);
		case "no-accounts":
			throw new Error(NO_ACCOUNTS_MESSAGE);
		default:
			return outcome.assessment;
	}
}

function isCursorCliOauthCredential(
	value: Credential | OAuthCredentials | undefined,
): value is CursorCliOauthCredential {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<CursorCliOauthCredential>;
	return candidate.type === "oauth" && Array.isArray(candidate.accounts);
}

function usableAccounts(value: Credential | OAuthCredentials | undefined): CursorCliAccountSlot[] {
	if (!isCursorCliOauthCredential(value)) return [];
	return listAccounts(value).filter(
		(slot) =>
			typeof slot.name === "string" &&
			typeof slot.access === "string" &&
			slot.access.trim().length > 0 &&
			typeof slot.refresh === "string" &&
			slot.refresh.trim().length > 0 &&
			typeof slot.expires === "number" &&
			Number.isFinite(slot.expires),
	);
}

function installationMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `cursor-agent not installed: ${detail.replace(/^Cursor CLI is not installed\.\s*/, "")}`;
}

/**
 * The typed turn-path error for a missing cursor-agent binary: carries the
 * `cursor-agent not installed` marker plus the install guidance verbatim, with
 * the underlying resolution failure preserved as `cause`.
 */
export function cursorAgentNotInstalledError(cause: unknown): Error {
	const error = new Error(installationMessage(cause));
	error.name = "CursorAgentNotInstalledError";
	error.cause = cause;
	return error;
}

/** Resolve credentials immediately before execution so a concurrent refresh cannot leave a stale token in memory. */
export async function resolveCursorCliOauthLane(deps: CursorCliOauthConfigDeps): Promise<CursorCliOauthLaneResolution> {
	const assessment = await configuredFor(deps);
	const account = assessment.accounts[0];
	if (!account) throw new Error(NO_ACCOUNTS_MESSAGE);
	return { lane: FILE_STORE_LANE, account, accounts: assessment.accounts };
}

async function loadCursorOAuthFlow(): Promise<OAuthAuth> {
	const flow = cursorProvider().auth.oauth;
	if (!flow) throw new Error("Cursor OAuth flow is unavailable");
	return flow;
}

function providerInteraction(callbacks: OAuthLoginCallbacks): ProviderAuthInteraction {
	return {
		signal: callbacks.signal ?? new AbortController().signal,
		prompt: async (prompt) => {
			switch (prompt.type) {
				case "select":
					return (await callbacks.onSelect(prompt)) ?? "";
				case "manual_code":
					return callbacks.onManualCodeInput?.() ?? callbacks.onPrompt(prompt);
				default:
					return callbacks.onPrompt(prompt);
			}
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
					break;
				case "device_code":
					callbacks.onDeviceCode(event);
					break;
				case "progress":
					callbacks.onProgress?.(event.message);
					break;
				case "info":
					callbacks.onProgress?.(event.message);
					break;
			}
		},
	};
}

async function accountName(
	existing: CursorCliAccountSlot[],
	onPrompt: OAuthLoginCallbacks["onPrompt"] | undefined,
): Promise<string> {
	if (existing.length === 0) return "default";
	const fallback = `account-${existing.length + 1}`;
	if (!onPrompt) return fallback;
	const answer = (
		await onPrompt({
			message: `Name for this account (existing: ${existing.map((slot) => slot.name).join(", ")})`,
			placeholder: fallback,
		})
	).trim();
	return answer || fallback;
}

function slotFromCredential(
	credential: Pick<OAuthCredentials, "access" | "refresh" | "expires">,
	name: string,
	source: CursorCliAccountSlot["source"],
): CursorCliAccountSlot {
	return {
		name,
		access: credential.access,
		refresh: credential.refresh,
		expires: credential.expires,
		source,
	};
}

/** The one-screen login explanation: what unattended Cursor CLI execution gives up, and the plan-mode alternative. */
export const CURSOR_CLI_OAUTH_LOGIN_ACKNOWLEDGEMENT_EXPLANATION = `${CURSOR_CLI_OAUTH_NO_APPROVAL_EXPLANATION} Plan mode (planning only, no tool execution) is available via the executionMode setting.`;

const ACKNOWLEDGEMENT_ACCEPTANCE = new Set(["yes", "y"]);

/**
 * Present the no-approval explanation exactly once and return the ISO
 * acknowledgement timestamp on explicit confirmation, undefined otherwise.
 * Shared by the login flow and the /cursor-account acknowledge subcommand so
 * both surfaces present the identical explanation and persist identically.
 */
export async function confirmCursorCliNoApprovalAcknowledgement(
	onPrompt: ((prompt: { message: string; placeholder?: string }) => Promise<string>) | undefined,
	now: () => Date,
): Promise<string | undefined> {
	if (!onPrompt) return undefined;
	const answer = (
		await onPrompt({
			message: `${CURSOR_CLI_OAUTH_LOGIN_ACKNOWLEDGEMENT_EXPLANATION}\nType "yes" to acknowledge and allow unattended Cursor CLI tool execution; anything else leaves it off.`,
		})
	)
		.trim()
		.toLowerCase();
	return ACKNOWLEDGEMENT_ACCEPTANCE.has(answer) ? now().toISOString() : undefined;
}

export function createCursorCliOauthConfig(deps: CursorCliOauthConfigDeps): CursorCliOauthConfig {
	return {
		name: CURSOR_CLI_OAUTH_NAME,
		isSubscription: true,

		async check(input) {
			// Tolerant by contract: ModelsImpl.getAvailable runs every provider's
			// check under Promise.all (packages/ai/src/models.ts:544-548) and turns a
			// throw into a rejecting ModelsError, so one throwing check would reject
			// all model listing. Not usable (disabled / not installed / no accounts)
			// reports undefined here - as claude-sdk-oauth's check does - while
			// turn-time resolution keeps throwing via configuredFor.
			//
			// One nuance: the auth-resolution path (checkAuth, resolveStoredOAuth)
			// always passes the stored credential, while bare model listing does not.
			// A credential-backed lane whose executable is missing stays selectable
			// with the install guidance as its source, so a TURN reaches
			// streamCursorCliOauth, which throws the typed not-installed error;
			// without a credential the lane hides exactly as before.
			const outcome = await assessConfiguration(deps);
			if (outcome.status === "disabled" || outcome.status === "no-accounts") return undefined;
			if (outcome.status === "not-installed") {
				return input.credential === undefined
					? undefined
					: { type: "oauth", source: installationMessage(outcome.error) };
			}
			return { type: "oauth", source: outcome.assessment.message };
		},

		async login(callbacks) {
			const stored = await deps.readCurrent();
			const current = isCursorCliOauthCredential(stored) ? stored : emptyCredential();
			const existing = listAccounts(current);
			const flow = await (deps.loadOAuth ?? loadCursorOAuthFlow)();
			const loggedIn = await flow.login(providerInteraction(callbacks));
			const name = await accountName(existing, callbacks.onPrompt);
			// After the PKCE flow succeeds and before the slot is stored: the
			// one-screen no-approval explanation, confirmed once. Declining still
			// stores the slot; only the acknowledgement stays unset, so force turns
			// refuse until the user acknowledges later.
			const acknowledgedAt = await confirmCursorCliNoApprovalAcknowledgement(
				callbacks.onPrompt,
				deps.now ?? (() => new Date()),
			);
			if (acknowledgedAt !== undefined) deps.persistAcknowledgement?.(acknowledgedAt);
			const credential = addAccount(current, slotFromCredential(loggedIn, name, "login"));
			deps.persistEnabled?.(true);
			return credential;
		},

		async refreshToken(credentials, signal) {
			if (!isCursorCliOauthCredential(credentials)) return credentials;
			const flow = await (deps.loadOAuth ?? loadCursorOAuthFlow)();
			const accounts: CursorCliAccountSlot[] = [];
			for (const slot of listAccounts(credentials)) {
				if (Date.now() < slot.expires) {
					accounts.push(slot);
					continue;
				}
				const refreshed = await flow.refresh(
					{
						type: "oauth",
						access: slot.access,
						refresh: slot.refresh,
						expires: slot.expires,
					},
					signal,
				);
				accounts.push({
					...slot,
					access: refreshed.access,
					refresh: refreshed.refresh,
					expires: refreshed.expires,
				});
			}
			return { ...credentials, ...SENTINEL_OAUTH_FIELDS, accounts };
		},

		getApiKey() {
			return SENTINEL_OAUTH_FIELDS.access;
		},
	};
}

function execFileOutput(file: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		nodeExecFile(file, args, { encoding: "utf8" }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const value = stdout.trim();
			resolve(value.length > 0 ? value : undefined);
		});
	});
}

async function defaultKeychainCredential(): Promise<ImportedCursorCredential | undefined> {
	if (process.platform !== "darwin") return undefined;
	const [access, refresh] = await Promise.all([
		execFileOutput("security", ["find-generic-password", "-a", "cursor-user", "-s", "cursor-access-token", "-w"]),
		execFileOutput("security", ["find-generic-password", "-a", "cursor-user", "-s", "cursor-refresh-token", "-w"]),
	]);
	return access && refresh ? { access, refresh } : undefined;
}

function localCursorAuthPath(platform: NodeJS.Platform): string | undefined {
	switch (platform) {
		case "darwin":
			return join(homedir(), ".cursor", "auth.json");
		case "linux":
			return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cursor", "auth.json");
		case "win32": {
			const appData = process.env.APPDATA;
			return appData ? join(appData, "Cursor", "auth.json") : undefined;
		}
		default:
			return undefined;
	}
}

async function defaultFileCredential(platform: NodeJS.Platform): Promise<ImportedCursorCredential | undefined> {
	const path = localCursorAuthPath(platform);
	if (!path) return undefined;
	try {
		const parsed: unknown = JSON.parse(await nodeReadFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		const access = record.accessToken;
		const refresh = record.refreshToken;
		if (typeof access !== "string" || access.length === 0 || typeof refresh !== "string" || refresh.length === 0) {
			return undefined;
		}
		return { access, refresh };
	} catch {
		return undefined;
	}
}

/** Explicitly copy the user's local Cursor credential into this provider's managed account slots. */
export async function importLocalCursorCredential(
	current: CursorCliOauthCredential,
	deps: LocalCursorImportDeps = {},
): Promise<CursorCliOauthCredential> {
	const platform = deps.platform ?? process.platform;
	const readKeychain = deps.readCursorKeychain ?? defaultKeychainCredential;
	const readFile = deps.readCursorFile ?? (() => defaultFileCredential(platform));
	const imported = platform === "darwin" ? ((await readKeychain()) ?? (await readFile())) : await readFile();
	if (!imported) throw new Error("No local Cursor OAuth credential found");
	const existing = listAccounts(current);
	const name = await accountName(existing, deps.onPrompt);
	return addAccount(
		current,
		slotFromCredential(
			{
				access: imported.access,
				refresh: imported.refresh,
				expires: imported.expires ?? Date.now() + DEFAULT_IMPORTED_EXPIRY_MS,
			},
			name,
			"import",
		),
	);
}

function isUsableFlatOAuthCredential(value: Credential | undefined): value is OAuthCredential {
	return (
		value?.type === "oauth" &&
		typeof value.access === "string" &&
		value.access.length > 0 &&
		typeof value.refresh === "string" &&
		value.refresh.length > 0 &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function nativeAccountName(existing: readonly CursorCliAccountSlot[]): string {
	const names = new Set(existing.map((account) => account.name));
	if (!names.has("native")) return "native";
	for (let index = 2; index <= 10_000; index++) {
		const candidate = `native-${index}`;
		if (!names.has(candidate)) return candidate;
	}
	throw new Error("Could not allocate a Cursor CLI OAuth native account name");
}

/** Explicitly copy Senpi's native `cursor` OAuth credential into a managed CLI account slot. */
export async function importNativeCursorCredential(
	current: CursorCliOauthCredential,
	readNativeCredential: () => Credential | undefined | Promise<Credential | undefined>,
): Promise<CursorCliOauthCredential> {
	const native = await readNativeCredential();
	if (!isUsableFlatOAuthCredential(native)) {
		throw new Error("No stored native Cursor OAuth credential found");
	}
	return addAccount(current, slotFromCredential(native, nativeAccountName(listAccounts(current)), "import"));
}

export function defaultCursorCliOauthConfig(
	cwd: string,
	readCurrent: () => Promise<Credential | undefined>,
): CursorCliOauthConfig {
	return createCursorCliOauthConfig({
		readCurrent,
		readSettings: () => loadCursorCliOauthProviderSettingsFromDisk(cwd),
		resolveExecutable: (settings) => {
			const executableDeps: CursorAgentExecutableDeps = {
				...defaultCursorAgentExecutableDeps(),
				settings,
			};
			return resolveCursorAgentExecutable(executableDeps);
		},
		now: () => new Date(),
		persistAcknowledgement: (acknowledgedAt: string) =>
			persistCursorCliNoApprovalAcknowledgement(cwd, acknowledgedAt),
		persistEnabled: (enabled: boolean) => persistCursorCliOauthEnabled(cwd, enabled),
	});
}
