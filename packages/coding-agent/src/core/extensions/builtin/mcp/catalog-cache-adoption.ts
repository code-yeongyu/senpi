import { legacyMcpCredentialIdentity } from "./auth/catalog-identity.ts";
import {
	getValidCachedServer,
	type McpCachedServerCatalog,
	type McpCatalogCacheFile,
	writeMcpCachedServer,
} from "./catalog-cache.ts";
import { legacyHashConfig } from "./config-identity.ts";
import type { McpServerDeclaredConfig } from "./config-schema.ts";

export interface McpCacheIdentity {
	readonly configHash: string;
	readonly credentialIdentity: string;
}

export interface McpCacheAdoption {
	readonly cache: McpCatalogCacheFile;
	readonly agentDir: string | undefined;
	readonly serverName: string;
	readonly current: McpCacheIdentity;
	readonly legacy: () => McpCacheIdentity | undefined;
}

/** The identities an earlier, unkeyed build persisted for this server, when its credential resolves now. */
export function legacyMcpCacheIdentity(
	config: McpServerDeclaredConfig,
	serverName: string,
	scope: { readonly agentDir?: string; readonly env?: Record<string, string | undefined> },
): McpCacheIdentity | undefined {
	const credentialIdentity = legacyMcpCredentialIdentity(config, serverName, scope.agentDir, scope.env);
	return credentialIdentity === undefined ? undefined : { configHash: legacyHashConfig(config), credentialIdentity };
}

/**
 * The cached catalog for the current keyed identity. An entry written under the unkeyed identities is adopted only
 * when both its config and its credential match, so a changed account never inherits another account's catalog,
 * and it is rewritten under the keyed identities.
 */
export async function adoptMcpCachedServer(adoption: McpCacheAdoption): Promise<McpCachedServerCatalog | undefined> {
	const { cache, serverName, current } = adoption;
	const cached = getValidCachedServer(cache, serverName, current.configHash, current.credentialIdentity);
	if (cached !== undefined) return cached;
	const legacy = adoption.legacy();
	if (legacy === undefined) return undefined;
	const previous = getValidCachedServer(cache, serverName, legacy.configHash, legacy.credentialIdentity);
	if (previous === undefined) return undefined;
	const migrated = { ...previous, configHash: current.configHash, credentialIdentity: current.credentialIdentity };
	await writeMcpCachedServer(adoption.agentDir, serverName, migrated);
	return migrated;
}
