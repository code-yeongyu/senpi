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
import type { ModelsJsonProvider } from "./model-config.ts";
import { checkConfiguredHeaderAuth, headerAuthResolutionSource } from "./provider-header-auth.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

interface ProviderAuthExtensionInput {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	oauth?: unknown;
}

export function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderAuthExtensionInput | undefined,
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey = configuredApiKey(config, extension);
	const oauth = extension?.oauth ?? base?.auth.oauth;
	const rawHeaders = configuredHeaders(config, extension);
	const headerSource = headerAuthResolutionSource(config?.headers, extension?.headers);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	if (!inherited && rawKey === undefined && !headerSource && oauth) {
		// An OAuth provider with no key, no credential headers and no base normally
		// gets no api-key auth at all. Providers with ambient credentials still
		// need this path, including metadata headers and authHeader composition.
		return ambientOnlyAuth(providerId, oauth, rawHeaders, headerSource, authHeader);
	}
	return {
		name: inherited?.name ?? "API key",
		login:
			inherited?.login ??
			(headerSource && rawKey === undefined
				? undefined
				: async (interaction: AuthInteraction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
					})),
		check: async (input) => {
			if (input.credential) {
				const inheritedCheck = await inherited?.check?.(input);
				if (inheritedCheck) return inheritedCheck;
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				const resolved = await inherited?.resolve(input);
				if (resolved) return { type: "api_key", source: resolved.source };
				return checkConfiguredHeaderAuth(rawHeaders, input.ctx, headerSource);
			}
			if (rawKey !== undefined) {
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
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
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
	rawHeaders: Record<string, string> | undefined,
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
		const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
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

export function configuredApiKey(
	config: ModelsJsonProvider | undefined,
	extension: ProviderAuthExtensionInput | undefined,
): string | undefined {
	return extension?.apiKey ?? config?.apiKey;
}

export function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	extension: ProviderAuthExtensionInput | undefined,
): Record<string, string> | undefined {
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
	rawKey: string | undefined,
	input: Parameters<ApiKeyAuth["resolve"]>[0],
): Promise<AuthResult | undefined> {
	if (input.credential) {
		return inherited
			? inherited.resolve(input)
			: input.credential.key
				? { auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" }
				: undefined;
	}
	if (rawKey === undefined) return inherited?.resolve(input);
	const env = await configContextEnv([rawKey], input.ctx);
	const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
	return inherited
		? inherited.resolve({ ...input, credential: { type: "api_key", key } })
		: { auth: { apiKey: key }, source: "configured API key" };
}

async function configContextEnv(
	values: readonly string[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}
