/**
 * The one request-auth composition step every model-call path shares (custody CK2, senpi#5831): configured
 * headers resolved field by field through an injected resolver, merged over the credential's own headers, and
 * `Authorization: Bearer <key>` composed when the provider sets `authHeader`. Local paths resolve fields from
 * configuration values (`configValueFieldResolver`); a hosted sealed egress resolves them from a custody lease.
 */
import { hasCredentialHeaders, type ModelAuth, type ProviderHeaders } from "@earendil-works/pi-ai";
import type { ConfigValue } from "@earendil-works/pi-ai/utils/config-reference";
import { assertConfigReferenceAuthority } from "../config-reference-resolver.ts";
import { resolveConfigValueOrThrow } from "../resolve-config-value.ts";

/** A secret position in a provider definition. */
export type SecretField =
	| "apiKey"
	| `credential:${number}`
	| `header:${string}`
	| `modelHeader:${string}:${string}`
	| "urlUserinfo"
	| `urlPath:${number}`
	| `urlQuery:${string}`;

/** Resolves one field's value, or throws the caller's own error for a field it cannot resolve. */
export type SecretFieldResolver = (field: SecretField) => string | Promise<string>;

export interface RequestAuthDefinition {
	/** Configured header names, in merge order. */
	readonly headerNames: readonly string[];
	readonly authHeader: boolean;
}

export function requestAuthDefinition(
	headers: Readonly<Record<string, ConfigValue>> | undefined,
	authHeader: boolean,
): RequestAuthDefinition {
	return { headerNames: Object.keys(headers ?? {}), authHeader };
}

/**
 * Today's configuration-value resolution for `header:<name>` fields: every value's reference authority is
 * checked before any value is resolved, and a failure names `<description> header "<name>"`.
 */
export function configValueFieldResolver(
	headers: Readonly<Record<string, ConfigValue>> | undefined,
	description: string,
	env: Record<string, string> | undefined,
): SecretFieldResolver {
	for (const value of Object.values(headers ?? {})) assertConfigReferenceAuthority(value);
	return (field) => {
		const name = field.startsWith("header:") ? field.slice("header:".length) : undefined;
		const value = name === undefined ? undefined : headers?.[name];
		if (name === undefined || value === undefined) throw new Error(`No configured value for ${field}`);
		return resolveConfigValueOrThrow(value, `${description} header "${name}"`, env);
	};
}

/**
 * Composes request auth over `base` (the resolved credential's own auth). Without a base, configured headers
 * count as auth only when they carry a credential; otherwise the result is `undefined`.
 */
export async function composeRequestAuth(
	base: ModelAuth,
	definition: RequestAuthDefinition,
	resolveField: SecretFieldResolver,
): Promise<ModelAuth>;
export async function composeRequestAuth(
	base: ModelAuth | undefined,
	definition: RequestAuthDefinition,
	resolveField: SecretFieldResolver,
): Promise<ModelAuth | undefined>;
export async function composeRequestAuth(
	base: ModelAuth | undefined,
	definition: RequestAuthDefinition,
	resolveField: SecretFieldResolver,
): Promise<ModelAuth | undefined> {
	const headers = await resolveHeaderFields(definition.headerNames, resolveField);
	if (!base && !hasCredentialHeaders(headers)) return undefined;
	const auth = base ?? {};
	let mergedHeaders: ProviderHeaders | undefined =
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (definition.authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

async function resolveHeaderFields(
	names: readonly string[],
	resolveField: SecretFieldResolver,
): Promise<Record<string, string> | undefined> {
	const resolved: Record<string, string> = {};
	for (const name of names) resolved[name] = await resolveField(`header:${name}`);
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}
