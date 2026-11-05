import {
	type AnyModel,
	type Api,
	type AuthCheck,
	isModelType,
	type Model,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ConfigValue } from "@earendil-works/pi-ai/utils/config-reference";
import { assertConfigReferenceAuthority } from "./config-reference-resolver.ts";
import type { ModelsJsonProvider } from "./model-config.ts";
import { configuredApiKey, configuredHeaders } from "./provider-api-key-auth.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";
import { configuredHeaderAuthStatus, headerAuthResolutionSource } from "./provider-header-auth.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

function rawModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, ConfigValue> | undefined {
	// models.json definitions and overrides are chat-only. Extension definitions
	// are matched by operation and id so colliding models cannot share headers.
	const chatDefinition = isModelType(model, "chat")
		? config?.models?.find((entry) => entry.id === model.id)
		: undefined;
	const extensionModel = extension?.models?.find(
		(entry) => (entry.type ?? "chat") === (model.type ?? "chat") && entry.id === model.id,
	);
	for (const [name, value] of Object.entries(extensionModel?.headers ?? {})) {
		assertConfigReferenceAuthority(value, {
			origin: "provider extension",
			field: `extension.models.${model.id}.headers.${name}`,
			authority: "extension",
		});
	}
	for (const value of [
		...Object.values(isModelType(model, "chat") ? (config?.modelOverrides?.[model.id]?.headers ?? {}) : {}),
		...Object.values(chatDefinition?.headers ?? {}),
	])
		assertConfigReferenceAuthority(value);
	const headers = {
		...(isModelType(model, "chat") ? config?.modelOverrides?.[model.id]?.headers : undefined),
		...chatDefinition?.headers,
		...extensionModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function resolveConfiguredModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, extension),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

/** Configured provider and model headers, resolved off the event loop. */
export async function resolveCompatibilityRequestHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Promise<ProviderHeaders | undefined> {
	const configured = await resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
		env,
	);
	return model.headers || configured ? { ...model.headers, ...configured } : undefined;
}

/**
 * A provider whose only credential is a configured header: models.json or an extension names credential
 * headers and no API key, and the provider's own auth `check` (from the last availability pass) fell back
 * to those headers rather than reporting a key of its own, such as a built-in provider's env key
 * (senpi#5707). Before any availability pass there is no check to read; the provider then does not read
 * as header-only, so image generation stays offered and a missing key surfaces at use.
 */
export function configuredAuthIsHeaderOnly(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	check: Pick<AuthCheck, "source"> | undefined,
): boolean {
	if (configuredApiKey(config, extension) !== undefined) return false;
	if (configuredHeaderAuthStatus(config?.headers, extension?.headers)?.configured !== true) return false;
	return check !== undefined && check.source === headerAuthResolutionSource(config?.headers, extension?.headers);
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) {
		return configuredHeaderAuthStatus(config?.headers, extension?.headers);
	}
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
