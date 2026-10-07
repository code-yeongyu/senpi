import { detectLiteralBearerWarnings, resolveServerAuth } from "./auth/context.ts";
import type { McpServerConfig } from "./config-schema.ts";
import { ServerConnection } from "./connection.ts";
import type { McpElicitationUiProvider } from "./elicitation.ts";
import type { McpOutputArtifacts } from "./guard/output-guard.ts";
import { markMcpConnectionNeedsAuth } from "./health.ts";
import { type HostMcpRegistry, shareable } from "./host-registry.ts";
import { configureMcpConnectionLifecycle, disposeMcpConnectionLifecycle } from "./idle.ts";
import { createMcpLogger } from "./log.ts";
import { configureMcpReconnect, disposeMcpReconnect } from "./reconnect.ts";
import type { McpConnectionEntry, McpSessionOptions } from "./service-types.ts";
import { SharedMcpLease } from "./shared-lease.ts";
import { connectAndRefreshMcpCatalog } from "./startup-race.ts";

interface SessionConnectionOptions {
	readonly registry: HostMcpRegistry;
	readonly share: boolean;
	readonly owner: object;
	readonly key: string;
	readonly name: string;
	readonly configHash: string;
	readonly config: McpServerConfig;
	readonly session: McpSessionOptions;
	readonly cwd: string;
	readonly ui: McpElicitationUiProvider;
	readonly artifacts: McpOutputArtifacts;
	readonly shouldReconnect: (entry: McpConnectionEntry) => boolean;
	readonly credentialIdentity?: string;
	readonly credentialsCurrent?: () => boolean;
	readonly onCredentialsChanged?: () => Promise<void>;
}

export function createMcpSessionConnection(options: SessionConnectionOptions): McpConnectionEntry {
	const { config, session, name, key, registry } = options;
	const logger = createMcpLogger(name, { logDir: session.logDir });
	const authPlan = resolveServerAuth({
		agentDir: session.agentDir,
		config,
		env: session.env,
		logger,
		serverName: name,
	});
	for (const warning of detectLiteralBearerWarnings(name, config)) logger.warn(warning);
	const connectionOptions = {
		credentialIdentity: options.credentialIdentity,
		credentialsCurrent: options.credentialsCurrent,
		authProvider: authPlan.provider,
		config,
		env: session.env,
		elicitationUiProvider: options.ui,
		logger,
		serverName: name,
	};
	const connection =
		options.share && session.agentDir !== undefined && shareable(config, options.cwd)
			? registry.attachShared(key, options.owner, {
					...connectionOptions,
					agentDir: session.agentDir,
					configHash: options.configHash,
				})
			: registry.attach(key, options.owner, () => new ServerConnection(connectionOptions));
	const entry: McpConnectionEntry = {
		agentDir: session.agentDir,
		artifacts: options.artifacts,
		authPlan,
		cacheRefreshedAfterConnect: false,
		isCurrent: () => options.shouldReconnect(entry),
		credentialIdentity: options.credentialIdentity,
		credentialsCurrent: options.credentialsCurrent,
		onCredentialsChanged: options.onCredentialsChanged,
		key,
		name,
		configHash: options.configHash,
		connection,
		logger,
		createdAtMs: Date.now(),
		counters: { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
	};
	if (connection instanceof SharedMcpLease) return entry;
	configureMcpConnectionLifecycle(connection, config, logger);
	configureMcpReconnect({
		connection,
		logger,
		reconnect: async () => {
			entry.counters.reconnectCount += 1;
			entry.cacheRefreshedAfterConnect = false;
			try {
				await entry.authPlan?.refresh?.ensureFresh();
			} catch (error) {
				const authError = markMcpConnectionNeedsAuth(entry.connection, error);
				if (authError !== undefined) {
					entry.logger.warn(authError.message);
					throw authError;
				}
				throw error;
			}
			await entry.connection.renew();
			await connectAndRefreshMcpCatalog(entry, config);
		},
		shouldReconnect: () => options.shouldReconnect(entry),
	});
	return entry;
}

export async function disposeEntryConnection(
	entry: McpConnectionEntry,
	registry: HostMcpRegistry,
	owner: object,
): Promise<void> {
	entry.disposeListChanged?.();
	entry.disposeWireStatus?.();
	disposeMcpReconnect(entry.connection);
	disposeMcpConnectionLifecycle(entry.connection);
	await registry.detach(entry.key, owner);
}
