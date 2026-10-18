/**
 * Provider-list builders for the /login and /logout selectors.
 *
 * Shared by the classic interactive mode and the RPC connection handler. Both
 * attribute a credential to a row through `authMethodStatus`, so a row either
 * surface lists gets the same status. RPC lists rows from
 * `buildLoginProviderInfos`; the TUI lists the methods each provider declares.
 */

import type { AuthCheck } from "@earendil-works/pi-ai";
import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "./model-registry.ts";
import type { AuthStatus } from "./provider-composer.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";

/** Built-in model providers (used to decide API-key vs oauth login eligibility). */
const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

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

/**
 * The status of ONE login method row, by one rule for every surface (#3537). A stored credential
 * belongs to the row of its own type. A non-stored sign-in (the provider's own check resolved
 * `type: "oauth"`, e.g. `CLAUDE_CODE_OAUTH_TOKEN` or an ambient Claude Code login) belongs to the
 * oauth row. Every other source (runtime `--api-key`, environment key, models.json, fallback) is a
 * key and belongs to the api_key row only: a key never lights a sign-in row, even on a provider
 * that lists no api_key row.
 */
export function authMethodStatus(modelRegistry: ModelRegistry, info: AuthProviderInfo): AuthStatus {
	if (modelRegistry.authStorage.get(info.id)?.type === info.authType) return { configured: true, source: "stored" };
	const { status, signIn } = modelRegistry.resolveProviderAuth(info.id);
	if (!status.configured || status.source === "stored") return { configured: false };
	return (signIn ? "oauth" : "api_key") === info.authType ? status : { configured: false };
}

/**
 * The TUI picker's single status for one row: the row's own `authMethodStatus` when it is
 * configured, otherwise the other method's, so the picker can say "API key configured" beside an
 * unconfigured sign-in row (#3537).
 */
export function loginRowStatus(
	modelRegistry: ModelRegistry,
	provider: { id: string; name: string },
	authType: "oauth" | "api_key",
): AuthCheck | undefined {
	for (const type of [authType, authType === "oauth" ? "api_key" : "oauth"] as const) {
		const status = authMethodStatus(modelRegistry, { ...provider, authType: type });
		if (!status.configured) continue;
		const source = status.label ?? status.source;
		return source === undefined ? { type } : { type, source };
	}
	return undefined;
}
