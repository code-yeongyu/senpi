import { randomUUID } from "node:crypto";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isEphemeralIdentity, keyedIdentity } from "../config-identity-key.ts";
import { canonicalAuthorizationServerIssuer } from "./oauth-issuer.ts";
import type { McpAuthorizationProof, McpClientRegistration, McpStoredAuth } from "./token-store.ts";

export type McpGrantRecord = Pick<
	McpStoredAuth,
	"accessToken" | "refreshToken" | "issuer" | "resource" | "scope" | "refreshScope"
> & {
	readonly authorization?: unknown;
	readonly clientInfo?: Pick<
		McpClientRegistration,
		"client_id" | "client_secret" | "token_endpoint_auth_method" | "issuer"
	>;
	readonly discoveryState?: { readonly authorizationServerUrl?: string | URL };
};

export interface McpGrantContext {
	readonly serverName: string;
	readonly serverUrl: string;
	readonly agentDir: string;
	readonly clientId?: string;
	readonly clientMetadataUrl?: string;
}

const authorizationSchema = Type.Object({
	version: Type.Literal(1),
	id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
	proof: Type.Optional(
		Type.Object({
			credentialIdentity: Type.String({ pattern: "^[0-9a-f]{64}$" }),
			previousCredentialIdentity: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
			issuer: Type.String({ minLength: 1 }),
			resource: Type.String({ minLength: 1 }),
			clientIdentity: Type.String({ pattern: "^[0-9a-f]{64}$" }),
			scope: Type.String({ minLength: 1 }),
			refreshScope: Type.Optional(Type.String({ minLength: 1 })),
		}),
	),
});
const epochSchema = Type.Object({
	version: Type.Literal(1),
	id: authorizationSchema.properties.id,
});

function authorizationEpoch(record: McpGrantRecord): string | undefined {
	const authorization: unknown = record.authorization;
	return Check(epochSchema, authorization) ? authorization.id : undefined;
}

function normalizeGrantedScope(scope: string | undefined): string | undefined {
	if (scope === undefined || !/^[\x21\x23-\x5b\x5d-\x7e]+(?: +[\x21\x23-\x5b\x5d-\x7e]+)*$/.test(scope))
		return undefined;
	return [...new Set(scope.split(" "))].filter(Boolean).sort().join(" ");
}

export function storedGrantIssuer(record: McpGrantRecord | undefined): string | undefined {
	return record?.issuer ?? record?.discoveryState?.authorizationServerUrl?.toString();
}

export function freezeGrantAttribution(record: McpStoredAuth | undefined): McpStoredAuth {
	const next: McpStoredAuth = { ...(record ?? {}) };
	if (next.issuer !== undefined || (next.accessToken === undefined && next.refreshToken === undefined)) return next;
	const issuer = storedGrantIssuer(next);
	if (issuer !== undefined) next.issuer = issuer;
	else delete next.refreshToken;
	return next;
}

export function storedAuthToTokens(record: McpStoredAuth | undefined, now = Date.now()): OAuthTokens | undefined {
	if (record?.accessToken === undefined || record.accessToken.length === 0) return undefined;
	const expiresIn =
		record.expiresAt === undefined ? undefined : Math.max(0, Math.ceil((record.expiresAt - now) / 1000));
	const issuer = storedGrantIssuer(record);
	return {
		access_token: record.accessToken,
		refresh_token: issuer === undefined ? undefined : record.refreshToken,
		token_type: "Bearer",
		scope: normalizeGrantedScope(record.scope),
		...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
		...(issuer === undefined ? {} : { issuer }),
	};
}

/** Maps one response; the caller decides which preceding fields it is entitled to inherit. */
export function mergeTokensIntoStoredAuth(current: McpStoredAuth, tokens: OAuthTokens): McpStoredAuth {
	const tokenLifetimeMs = tokens.expires_in === undefined ? undefined : tokens.expires_in * 1000;
	return {
		...current,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token ?? current.refreshToken,
		scope: normalizeGrantedScope(tokens.scope),
		expiresAt: tokenLifetimeMs === undefined ? undefined : Date.now() + tokenLifetimeMs,
		tokenLifetimeMs,
		issuer: tokens.issuer ?? current.issuer,
	};
}

export interface McpTokenResponse {
	readonly tokens: OAuthTokens;
	readonly resource: string;
	readonly fresh: boolean;
	readonly presented?: McpStoredAuth;
	readonly clientInfo?: McpClientRegistration;
}

/** An SDK response has no locked predecessor; only explicit fresh acquisition can establish its initial proof. */
export function mergeOAuthTokenResponse(
	current: McpStoredAuth,
	context: McpGrantContext,
	response: McpTokenResponse,
): McpStoredAuth {
	const { tokens, resource, fresh, presented, clientInfo } = response;
	// Attribute a response to the client selected before the request, never to a later store writer.
	const active = {
		...current,
		clientInfo,
		pendingClientInfo:
			current.pendingClientInfo?.client_id === clientInfo?.client_id ? undefined : current.pendingClientInfo,
	};
	const binding = grantBinding({ ...active, issuer: tokens.issuer, resource }, context);
	const canInherit =
		!fresh &&
		presented !== undefined &&
		JSON.stringify(grantBinding(presented, context)) === JSON.stringify(grantBinding(current, context)) &&
		JSON.stringify(grantBinding(presented, context)) === JSON.stringify(binding) &&
		presented.accessToken === current.accessToken &&
		presented.refreshToken === current.refreshToken &&
		presented.authorization?.id === current.authorization?.id;
	const base = {
		...active,
		issuer: tokens.issuer,
		resource,
		refreshToken: canInherit ? presented.refreshToken : undefined,
		scope: undefined,
		refreshScope: undefined,
		authorization: undefined,
	};
	const next = mergeTokensIntoStoredAuth(base, tokens);
	return fresh
		? withGrantAuthorization({ ...next, refreshScope: next.scope }, context)
		: { ...next, authorization: { version: 1, id: randomUUID() } };
}

/** Active binding excludes pending registrations and display/redirect metadata. */
export function grantBinding(record: McpGrantRecord, context: McpGrantContext) {
	const issuer = storedGrantIssuer(record);
	const registration = record.clientInfo;
	const clientId = context.clientId ?? context.clientMetadataUrl ?? registration?.client_id;
	const configured = context.clientId !== undefined || context.clientMetadataUrl !== undefined;
	const clientIssuer = configured ? issuer : (registration?.issuer ?? issuer);
	const clientIdentity =
		clientId === undefined
			? undefined
			: keyedIdentity(
					context.agentDir,
					JSON.stringify([
						"mcp-oauth-client-v1",
						clientId,
						configured ? null : (registration?.client_secret ?? null),
						configured ? null : (registration?.token_endpoint_auth_method ?? null),
						clientIssuer === undefined ? null : canonicalAuthorizationServerIssuer(clientIssuer),
					]),
				);
	return {
		issuer: issuer === undefined ? undefined : canonicalAuthorizationServerIssuer(issuer),
		resource: record.resource,
		clientIdentity,
		scope: normalizeGrantedScope(record.scope),
		refreshScope: normalizeGrantedScope(record.refreshScope),
	};
}

function credentialCommitment(record: McpGrantRecord, context: McpGrantContext, id: string | undefined): string {
	const binding = grantBinding(record, context);
	return keyedIdentity(
		context.agentDir,
		JSON.stringify([
			"mcp-oauth-credential-v1",
			context.serverName,
			context.serverUrl,
			id ?? null,
			record.accessToken ?? null,
			record.refreshToken ?? null,
			binding.issuer ?? null,
			binding.resource ?? null,
			binding.clientIdentity ?? null,
			binding.scope ?? null,
			binding.refreshScope ?? null,
		]),
	);
}

export function validGrantProof(record: McpGrantRecord, context: McpGrantContext): McpAuthorizationProof | undefined {
	const authorization: unknown = record.authorization;
	if (!Check(authorizationSchema, authorization) || authorization.proof === undefined) return undefined;
	const proof = authorization.proof;
	const binding = grantBinding(record, context);
	if (Object.entries(binding).some(([key, value]) => Reflect.get(proof, key) !== value)) return undefined;
	return proof.credentialIdentity === credentialCommitment(record, context, authorization.id) ? proof : undefined;
}

/** Only the refresh transaction passes a predecessor, read while holding its existing token-store lock. */
export function withGrantAuthorization(
	record: McpStoredAuth,
	context: McpGrantContext,
	previous?: McpStoredAuth,
): McpStoredAuth {
	const predecessor = previous === undefined ? undefined : validGrantProof(previous, context);
	const binding = grantBinding(record, context);
	const sameBinding =
		predecessor !== undefined &&
		Object.entries(binding).every(([key, value]) => Reflect.get(predecessor, key) === value);
	const id = sameBinding && previous?.authorization !== undefined ? previous.authorization.id : randomUUID();
	const credentialIdentity = credentialCommitment(record, context, id);
	const proof =
		binding.issuer !== undefined &&
		binding.resource !== undefined &&
		binding.clientIdentity !== undefined &&
		binding.scope !== undefined &&
		!isEphemeralIdentity(credentialIdentity)
			? {
					...binding,
					issuer: binding.issuer,
					resource: binding.resource,
					clientIdentity: binding.clientIdentity,
					scope: binding.scope,
					credentialIdentity,
					previousCredentialIdentity:
						previous === undefined
							? undefined
							: credentialCommitment(previous, context, authorizationEpoch(previous)),
				}
			: undefined;
	return { ...record, authorization: { version: 1, id, proof } };
}

export function oauthGrantIdentity(record: McpGrantRecord, context: McpGrantContext): string {
	const epoch = authorizationEpoch(record);
	const proof = validGrantProof(record, context);
	return proof === undefined
		? keyedIdentity(
				context.agentDir,
				JSON.stringify(["mcp-oauth-opaque-v1", credentialCommitment(record, context, epoch)]),
			)
		: keyedIdentity(
				context.agentDir,
				JSON.stringify([
					"mcp-oauth-authorization-v1",
					context.serverName,
					context.serverUrl,
					epoch,
					proof.issuer,
					proof.resource,
					proof.clientIdentity,
					proof.scope,
					proof.refreshScope ?? null,
				]),
			);
}
