import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keyedIdentity } from "../config-identity-key.ts";
import type { McpServerDeclaredConfig } from "../config-schema.ts";
import { resolveAuthMode } from "./context.ts";
import { McpTokenStore } from "./token-store.ts";

/** Local snapshot only: never migrates credentials, acquires a lock, or refreshes authentication. */
export function mcpCredentialIdentity(
	config: McpServerDeclaredConfig,
	serverName: string,
	agentDir: string | undefined,
	env: Record<string, string | undefined> | undefined,
): string | undefined {
	const material = credentialMaterial(config, serverName, agentDir, env);
	return material === undefined || material === "none" ? material : keyedIdentity(agentDir, material);
}

/** The unkeyed identity earlier builds persisted; read only to adopt a cache entry for the same credential. */
export function legacyMcpCredentialIdentity(
	config: McpServerDeclaredConfig,
	serverName: string,
	agentDir: string | undefined,
	env: Record<string, string | undefined> | undefined,
): string | undefined {
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
		if (typeof value !== "object" || value === null || !("accessToken" in value)) return undefined;
		if (typeof value.accessToken !== "string" || value.accessToken.length === 0) return undefined;
		const refreshToken = "refreshToken" in value ? value.refreshToken : undefined;
		if (refreshToken !== undefined && typeof refreshToken !== "string") return undefined;
		return JSON.stringify(["mcp-catalog-oauth", value.accessToken, refreshToken]);
	} catch (error) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}
