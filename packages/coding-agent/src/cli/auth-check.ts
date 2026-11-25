import type { CredentialStore } from "@earendil-works/pi-ai";
import { AuthStorage, ReadOnlyAuthStorage } from "../core/auth-storage.ts";
import { summarizeCredentialAccounts } from "../core/credential-accounts.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
import type { Args } from "./args.ts";
import { type AuthAccount, splitAccount } from "./auth-account-check.ts";
import { AuthCommandError, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

export type AuthCheckStatus = "ready" | "not_ready" | "invalid";
export type AuthCheckReason =
	| "provider_not_found"
	| "credentials_not_configured"
	| "credential_not_available"
	| "invalid_state";

export interface AuthCheckResult {
	status: AuthCheckStatus;
	provider: string;
	reason?: AuthCheckReason;
	authType?: "api_key" | "oauth";
}

export async function checkProviderAuth(
	args: Args,
	modelRuntime: ModelRuntime,
	options: { refresh: boolean } = { refresh: false },
): Promise<AuthCheckResult> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, "check");
	let provider = cliProvider;
	if (cliModel) {
		const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new AuthCommandError(resolved.error ?? `Unable to resolve model "${cliModel}"`);
		}
		provider = resolved.model.provider;
	}
	if (!provider) throw new AuthCommandError("Unable to resolve an auth provider");
	if (modelRuntime.getError()) {
		return { status: "invalid", provider, reason: "invalid_state" };
	}
	if (!modelRuntime.getProvider(provider)) {
		return { status: "not_ready", provider, reason: "provider_not_found" };
	}
	try {
		const auth = await modelRuntime.checkAuth(provider);
		if (!auth) return { status: "not_ready", provider, reason: "credentials_not_configured" };
		if (options.refresh && !(await modelRuntime.getAuth(provider))) {
			return { status: "not_ready", provider, reason: "credentials_not_configured" };
		}
		return { status: "ready", provider, authType: auth.type };
	} catch {
		return { status: "invalid", provider, reason: "invalid_state" };
	}
}

export interface AuthCheckOutcome {
	readonly result: AuthCheckResult;
	/** Present only under `json`; each connection test split into its closed code and the provider's text. */
	readonly accounts?: AuthAccount[];
	/** Present only when `credential` was asked and the provider is ready; never leaves the CLI's own print. */
	readonly credential?: string;
}

/**
 * `auth check`: the one core the command and `engine.auth.check` share. A refusal of the arguments throws
 * `AuthCommandError`; an unreadable auth state answers `invalid`.
 */
export async function runAuthCheck(
	parsed: Args,
	options: { readonly refresh: boolean; readonly json: boolean; readonly credential: boolean },
): Promise<AuthCheckOutcome> {
	const requested = validateAuthCommandArgs(parsed, "check");
	let result: AuthCheckResult;
	let credential: string | undefined;
	try {
		const credentials = options.refresh ? AuthStorage.create() : new ReadOnlyAuthStorage();
		const modelRuntime = await createAuthCheckModelRuntime(credentials);
		result = await checkProviderAuth(parsed, modelRuntime, { refresh: options.refresh });
		if (options.credential && result.status === "ready") {
			credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
				refresh: options.refresh,
			});
			if (!credential) {
				result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
			}
		}
	} catch {
		result = { status: "invalid", provider: requested.provider ?? requested.model ?? "", reason: "invalid_state" };
	}
	let accounts: AuthAccount[] = [];
	if (options.json && result.status !== "invalid") {
		try {
			const credentials = options.refresh ? AuthStorage.create() : new ReadOnlyAuthStorage();
			const summaries = await summarizeCredentialAccounts(result.provider, await credentials.read(result.provider));
			accounts = summaries.map(splitAccount);
		} catch {
			// Account enrichment must never turn a readable auth state into a failure.
		}
	}
	return {
		result,
		...(options.json ? { accounts } : {}),
		...(credential === undefined ? {} : { credential }),
	};
}

export async function getProviderCredential(
	providerId: string,
	modelRuntime: ModelRuntime,
	credentials: CredentialStore,
	options: { refresh: boolean },
): Promise<string | undefined> {
	const credential = await credentials.read(providerId);
	if (!options.refresh && credential?.type === "oauth") return credential.access;
	return getAuthCredential(await modelRuntime.getAuth(providerId));
}

export async function createAuthCheckModelRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}
