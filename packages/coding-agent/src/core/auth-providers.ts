/**
 * Provider-list builders for the /login and /logout selectors.
 *
 * This is the single source of truth shared by the classic interactive mode and
 * the RPC connection handler (neo). It intentionally depends only on the
 * ModelRegistry (and its AuthStorage) so both the TUI and the headless RPC path
 * produce IDENTICAL provider lists — same ids, same display names, same
 * oauth/api_key classification, same status source.
 */

import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "./model-registry.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";

/** Built-in model providers (used to decide API-key vs oauth login eligibility). */
const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

/** Providers that must never be offered as API-key login (OAuth-only). */
const OAUTH_ONLY_MODEL_PROVIDERS = new Set(["openai-codex-device", "google-gemini-cli", "google-antigravity"]);

/** One provider entry for a login/logout selector. */
export interface AuthProviderInfo {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
}

/**
 * Whether a provider should be offered for API-key login.
 *
 * - A provider with a built-in display name is always API-key eligible.
 * - A built-in model provider without a display name is not (it authenticates
 *   via oauth or is otherwise not an API-key login target).
 * - Any other provider is API-key eligible unless it is an oauth provider.
 */
export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (OAUTH_ONLY_MODEL_PROVIDERS.has(providerId) || oauthProviderIds.has(providerId)) {
		return false;
	}
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

/**
 * Build the /login provider options: every oauth provider plus every API-key
 * eligible model provider, sorted by display name. When `authType` is given the
 * list is narrowed to that kind.
 */
export function buildLoginProviderInfos(
	modelRegistry: ModelRegistry,
	authType?: "oauth" | "api_key",
): AuthProviderInfo[] {
	const authStorage = modelRegistry.authStorage;
	const oauthProviders = authStorage.getOAuthProviders();
	const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));

	const options: AuthProviderInfo[] = oauthProviders.map((provider) => ({
		id: provider.id,
		name: provider.name,
		authType: "oauth",
	}));

	const modelProviders = new Set(modelRegistry.getAll().map((model) => model.provider));
	for (const providerId of modelProviders) {
		if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
			continue;
		}
		options.push({
			id: providerId,
			name: modelRegistry.getProviderDisplayName(providerId),
			authType: "api_key",
		});
	}

	const filtered = authType ? options.filter((option) => option.authType === authType) : options;
	return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the /logout provider options: every provider with a stored credential,
 * sorted by display name. Environment variables and models.json config are not
 * listed — /logout only removes credentials saved by /login.
 */
export function buildLogoutProviderInfos(modelRegistry: ModelRegistry): AuthProviderInfo[] {
	const authStorage = modelRegistry.authStorage;
	const options: AuthProviderInfo[] = [];
	for (const providerId of Object.keys(authStorage.getAll())) {
		const credential = authStorage.get(providerId);
		if (!credential) {
			continue;
		}
		options.push({
			id: providerId,
			name: modelRegistry.getProviderDisplayName(providerId),
			authType: credential.type,
		});
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}
