import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { keyedIdentity } from "../config-identity-key.ts";
import type { McpServerDeclaredConfig } from "../config-schema.ts";
import { resolveAuthMode } from "./context.ts";
import { oauthGrantIdentity } from "./oauth-grant.ts";
import { McpTokenStore } from "./token-store.ts";

/** Local snapshot only: never migrates credentials, acquires a lock, or refreshes authentication. */
export function mcpCredentialIdentity(
	config: McpServerDeclaredConfig,
	serverName: string,
	agentDir: string | undefined,
	env: Record<string, string | undefined> | undefined,
): string | undefined {
	const material = credentialMaterial(config, serverName, agentDir, env);
	return material === undefined || material === "none" || resolveAuthMode(config) === "oauth"
		? material
		: keyedIdentity(agentDir, material);
}

/** The unkeyed identity earlier builds persisted; read only to adopt a cache entry for the same credential. */
export function legacyMcpCredentialIdentity(
	config: McpServerDeclaredConfig,
	serverName: string,
	agentDir: string | undefined,
	env: Record<string, string | undefined> | undefined,
): string | undefined {
	if (resolveAuthMode(config) === "oauth") return undefined;
	const material = credentialMaterial(config, serverName, agentDir, env);
	return material === undefined || material === "none"
		? material
		: createHash("sha256").update(material).digest("hex");
}

function credentialMaterial(
	config: McpServerDeclaredConfig,
	serverName: string,
	agentDir: string | undefined,
	env: Record<string, string | undefined> | undefined,
): string | undefined {
	const mode = resolveAuthMode(config);
	if (mode === "none") return "none";
	if (mode === "bearer") {
		const name = config.bearerTokenEnv;
		if (name === undefined) return undefined;
		const token = env?.[name] ?? process.env[name];
		if (token === undefined || token.length === 0) return undefined;
		return JSON.stringify(["mcp-catalog-bearer", token]);
	}
	try {
		const store = new McpTokenStore({ serverName, serverUrl: config.url ?? "", agentDir });
		const value: unknown = JSON.parse(readFileSync(store.tokensPath, "utf8"));
		if (!Check(storedGrantSchema, value)) return undefined;
		return oauthGrantIdentity(value, {
			serverName,
			serverUrl: store.serverUrl,
			agentDir: store.agentDir,
			clientId: config.oauth?.clientId,
			clientMetadataUrl: config.oauth?.clientMetadataUrl,
		});
	} catch (error) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}

// Parse exactly the stored fields the identity reader consumes; authorization is parsed by its proof owner.
const storedGrantSchema = Type.Object({
	accessToken: Type.String({ minLength: 1 }),
	refreshToken: Type.Optional(Type.String()),
	issuer: Type.Optional(Type.String()),
	resource: Type.Optional(Type.String()),
	scope: Type.Optional(Type.String()),
	refreshScope: Type.Optional(Type.String()),
	clientInfo: Type.Optional(
		Type.Object({
			client_id: Type.String(),
			client_secret: Type.Optional(Type.String()),
			token_endpoint_auth_method: Type.Optional(Type.String()),
			issuer: Type.Optional(Type.String()),
		}),
	),
	discoveryState: Type.Optional(Type.Object({ authorizationServerUrl: Type.String() })),
});
