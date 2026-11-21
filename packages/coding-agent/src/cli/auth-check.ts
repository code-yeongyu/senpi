import type { CredentialStore } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { replayExtensionProviderRegistrations } from "../core/agent-session-services.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import type { Args } from "./args.ts";
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

export interface AuthCheckRuntimeOptions {
	cwd: string;
	agentDir?: string;
	resourceLoaderOptions?: Pick<
		DefaultResourceLoaderOptions,
		"additionalExtensionPaths" | "extensionFactories" | "noExtensions"
	>;
}

/**
 * A runtime holding every provider a generation can use: the built-in catalog plus the providers
 * extensions register (`anthropic-subscription` is one), so `auth check` cannot report
 * `provider_not_found` for a provider that generations reach (senpi#2191). Extensions are loaded
 * the way session services load them, but the caller's credential store stays the only one: session
 * services would open a writable `auth.json`, which a `--no-refresh` check must never create.
 */
export async function createAuthCheckModelRuntime(
	credentials: CredentialStore,
	options: AuthCheckRuntimeOptions,
): Promise<ModelRuntime> {
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(options.cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		...options.resourceLoaderOptions,
		cwd: options.cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	modelRuntime.setSettingsManager(settingsManager);
	const { registeredProviders } = replayExtensionProviderRegistrations(
		modelRuntime,
		resourceLoader.getExtensions().runtime,
	);
	if (registeredProviders.size > 0) {
		await modelRuntime.refresh({ allowNetwork: false, providers: [...registeredProviders] });
	}
	return modelRuntime;
}
