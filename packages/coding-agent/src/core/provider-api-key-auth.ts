import {
	type ApiKeyAuth,
	type AuthContext,
	type AuthInteraction,
	type AuthResult,
	hasCredentialHeaders,
	type ModelAuth,
	type Provider,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ConfigValue } from "@earendil-works/pi-ai/utils/config-reference";
import { assertConfigReferenceAuthority } from "./config-reference-resolver.ts";
import type { ModelsJsonProvider } from "./model-config.ts";
import { checkConfiguredHeaderAuth, headerAuthResolutionSource } from "./provider-header-auth.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

/** Reads another provider's stored credential env: routing metadata only, never keys. */
export type StoredProviderEnvReader = (providerId: string) => Promise<Record<string, string> | undefined>;

interface AmbientAuthExtensionInput {
	name?: string;
	resolve(input: {
		ctx: AuthContext;
		signal: AbortSignal;
		storedProviderEnv?: StoredProviderEnvReader;
	}): Promise<AuthResult | undefined>;
}

interface ProviderAuthExtensionInput {
	apiKey?: string;
	headers?: Record<string, string>;
	models?: Array<{ id: string; headers?: Record<string, string> }>;
	authHeader?: boolean;
	oauth?: unknown;
	ambientAuth?: AmbientAuthExtensionInput;
}

export function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderAuthExtensionInput | undefined,
	options?: { storedProviderEnv?: StoredProviderEnvReader },
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey = configuredApiKey(config, extension);
	const oauth = extension?.oauth ?? base?.auth.oauth;
	const rawHeaders = configuredHeaders(config, extension);
	const headerSource = headerAuthResolutionSource(config?.headers, extension?.headers);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	const ambient = extension?.ambientAuth;
	if (!inherited && rawKey === undefined && !headerSource && ambient) {
		// A shared cloud credential chain (Google ADC, AWS env) owns the lane: an
		// explicitly configured key, credential headers, or a base provider still
		// win, and a resolution marked ambient never outranks a configured
		// provider in automatic default selection (senpi#2327).
		return ambientApiKeyAuth(providerId, ambient, rawHeaders, headerSource, authHeader, options?.storedProviderEnv);
	}
	if (!inherited && rawKey === undefined && !headerSource && oauth) {
		// An OAuth provider with no key, no credential headers and no base normally
		// gets no api-key auth at all. Providers with ambient credentials still
		// need this path, including metadata headers and authHeader composition.
		return ambientOnlyAuth(providerId, oauth, rawHeaders, headerSource, authHeader);
	}
	return {
		name: inherited?.name ?? "API key",
		...(inherited?.keyOptional ? { keyOptional: true } : {}),
		login:
			inherited?.login ??
			(headerSource && rawKey === undefined
				? undefined
				: async (interaction: AuthInteraction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
					})),
		check: async (input) => {
			if (input.credential?.key) {
				const inheritedCheck = await inherited?.check?.(input);
				if (inheritedCheck) return inheritedCheck;
				return { type: "api_key", source: "stored credential" };
			}
			if (rawKey !== undefined) {
				if (typeof rawKey !== "string") return { type: "api_key", source: "configured API key" };
				if (isCommandConfigValue(rawKey)) return { type: "api_key", source: "configured API key" };
				for (const name of getConfigValueEnvVarNames(rawKey)) {
					if ((await input.ctx.env(name)) === undefined) return undefined;
				}
				return { type: "api_key", source: "configured API key" };
			}
			const inheritedCheck = await inherited?.check?.(input);
			if (inheritedCheck) return inheritedCheck;
			const resolved = await inherited?.resolve(input);
			if (resolved) return { type: "api_key", source: resolved.source };
			return checkConfiguredHeaderAuth(rawHeaders, input.ctx, headerSource);
		},
		resolve: async (input) => {
			const result = await resolveBaseAuth(providerId, inherited, rawKey, input);
			const explicitEnv = { ...(input.credential?.env ?? {}), ...(result?.env ?? {}) };
			const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
			const headers = await resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			if (!result && !hasCredentialHeaders(headers)) return undefined;
			return {
				...result,
				auth: withConfiguredAuth(result?.auth ?? {}, headers, authHeader),
				source: result?.source ?? headerSource,
			};
		},
	};
}

type AmbientResolver = (input: {
	ctx: AuthContext;
	env?: Record<string, string>;
	signal?: AbortSignal;
}) => Promise<AuthResult | undefined>;

function ambientResolverOf(oauth: unknown): AmbientResolver | undefined {
	const candidate = (oauth as { resolveAmbient?: unknown } | undefined)?.resolveAmbient;
	return typeof candidate === "function" ? (candidate as AmbientResolver) : undefined;
}

/** Api-key adapter for OAuth providers whose credentials live outside auth.json. */
function ambientOnlyAuth(
	providerId: string,
	oauth: unknown,
	rawHeaders: Record<string, ConfigValue> | undefined,
	headerSource: string | undefined,
	authHeader: boolean,
): ApiKeyAuth | undefined {
	const resolveAmbient = ambientResolverOf(oauth);
	if (!resolveAmbient) return undefined;
	const resolve = async (input: Parameters<ApiKeyAuth["resolve"]>[0]): Promise<AuthResult | undefined> => {
		const result = await resolveAmbient({
			ctx: input.ctx,
			env: input.credential?.env,
			signal: input.signal,
		});
		// Auxiliary callers replay resolved auth as an explicit key. Accept only
		// this ambient resolver's own marker; unrelated explicit credentials stay
		// outside an OAuth-only provider.
		if (!result || (input.credential?.key && input.credential.key !== result.auth.apiKey)) return undefined;
		const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
		const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
		const headers = await resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
		return {
			...result,
			auth: withConfiguredAuth(result.auth, headers, authHeader),
			source: result.source ?? headerSource,
		};
	};
	return {
		name: (oauth as { name?: string }).name ?? "Ambient credentials",
		ambientOnly: true,
		check: async (input) => {
			const resolved = await resolve(input);
			return resolved ? { type: "oauth", source: resolved.source } : undefined;
		},
		resolve,
	};
}

/**
 * Api-key adapter for extension providers whose credentials live in a shared
 * cloud credential chain (Google ADC, AWS env). No login is offered — the chain
 * is the only source — and `Models.checkAuth` resolves this auth, so the
 * `ambient` marker reaches the provider's auth status.
 */
function ambientApiKeyAuth(
	providerId: string,
	ambient: AmbientAuthExtensionInput,
	rawHeaders: Record<string, ConfigValue> | undefined,
	headerSource: string | undefined,
	authHeader: boolean,
	storedProviderEnv?: StoredProviderEnvReader,
): ApiKeyAuth {
	const resolve = async (input: Parameters<ApiKeyAuth["resolve"]>[0]): Promise<AuthResult | undefined> => {
		const result = await ambient.resolve({
			ctx: input.ctx,
			signal: input.signal,
			...(storedProviderEnv ? { storedProviderEnv } : {}),
		});
		if (!result) return undefined;
		const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
		const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
		const headers = await resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
		// Stored-then-env (helpers.ts invariant): the provider's own stored env wins over ambient-resolved env.
		const env =
			result.env || input.credential?.env ? { ...(result.env ?? {}), ...(input.credential?.env ?? {}) } : undefined;
		return {
			...result,
			...(env ? { env } : {}),
			auth: withConfiguredAuth(result.auth, headers, authHeader),
			source: result.source ?? headerSource,
		};
	};
	return {
		name: ambient.name ?? "Ambient credentials",
		ambientOnly: true,
		resolve,
	};
}

export function configuredApiKey(
	config: ModelsJsonProvider | undefined,
	extension: ProviderAuthExtensionInput | undefined,
): ConfigValue | undefined {
	if (extension?.apiKey !== undefined) {
		assertConfigReferenceAuthority(extension.apiKey, {
			origin: "provider extension",
			field: "extension.apiKey",
			authority: "extension",
		});
	}
	if (config?.apiKey !== undefined) assertConfigReferenceAuthority(config.apiKey);
	return extension?.apiKey ?? config?.apiKey;
}

export function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	extension: ProviderAuthExtensionInput | undefined,
): Record<string, ConfigValue> | undefined {
	for (const model of extension?.models ?? []) {
		for (const [name, value] of Object.entries(model.headers ?? {})) {
			assertConfigReferenceAuthority(value, {
				origin: "provider extension",
				field: `extension.models.${model.id}.headers.${name}`,
				authority: "extension",
			});
		}
	}
	for (const [name, value] of Object.entries(extension?.headers ?? {})) {
		assertConfigReferenceAuthority(value, {
			origin: "provider extension",
			field: `extension.headers.${name}`,
			authority: "extension",
		});
	}
	for (const value of Object.values(config?.headers ?? {})) assertConfigReferenceAuthority(value);
	if (!config?.headers && !extension?.headers) return undefined;
	return { ...config?.headers, ...extension?.headers };
}

export function withConfiguredAuth(
	auth: ModelAuth,
	headers: ProviderHeaders | undefined,
	authHeader: boolean,
): ModelAuth {
	let mergedHeaders: ProviderHeaders | undefined =
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

async function resolveBaseAuth(
	providerId: string,
	inherited: ApiKeyAuth | undefined,
	rawKey: ConfigValue | undefined,
	input: Parameters<ApiKeyAuth["resolve"]>[0],
): Promise<AuthResult | undefined> {
	if (input.credential?.key) {
		return inherited
			? inherited.resolve(input)
			: { auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" };
	}
	if (rawKey === undefined) return inherited?.resolve(input);
	const env = await configContextEnv([rawKey], input.ctx, input.credential?.env);
	const key = await resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
	return inherited
		? inherited.resolve({ ...input, credential: { type: "api_key", key } })
		: { auth: { apiKey: key }, source: "configured API key" };
}

async function configContextEnv(
	values: readonly ConfigValue[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return Object.keys(env).length > 0 || values.some((value) => typeof value !== "string") ? env : undefined;
}
