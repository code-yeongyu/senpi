import { detectLiteralBearerWarnings, resolveServerAuth } from "./auth/context.ts";
import { type McpConfigGeneration, mcpConnectionIdentity, mcpGenerationRenewal } from "./config-generation.ts";
import type { McpServerDeclaredConfig } from "./config-schema.ts";
import { ServerConnection } from "./connection.ts";
import type { McpElicitationUiProvider } from "./elicitation.ts";
import type { McpOutputArtifacts } from "./guard/output-guard.ts";
import { markMcpConnectionNeedsAuth } from "./health.ts";
import { type HostMcpRegistry, shareable } from "./host-registry.ts";
import { configureMcpConnectionLifecycle, disposeMcpConnectionLifecycle } from "./idle.ts";
import { createMcpLogger } from "./log.ts";
import { getProjectMcpAuthority } from "./project-skill-policy.ts";
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
	readonly generation: McpConfigGeneration;
	readonly declared: McpServerDeclaredConfig;
	readonly session: McpSessionOptions;
	readonly elicitationEnabled: boolean;
	readonly cwd: string;
	readonly ui: McpElicitationUiProvider;
	readonly artifacts: McpOutputArtifacts;
	readonly shouldReconnect: (entry: McpConnectionEntry) => boolean;
	readonly credentialIdentity?: string;
	readonly credentialsCurrent?: () => boolean;
	readonly onCredentialsChanged?: () => Promise<void>;
}

export function createMcpSessionConnection(options: SessionConnectionOptions): McpConnectionEntry {
	const { session, name, key, registry } = options;
	const config = options.generation.config;
	// The project authority is keyed by the declared config object; the generation snapshot is a new object.
	const projectPolicy = getProjectMcpAuthority(options.declared);
	const logger = createMcpLogger(name, { logDir: session.logDir });
	const authPlan = resolveServerAuth({
		agentDir: session.agentDir,
		config,
		env: session.env,
		logger,
		serverName: name,
	});
	for (const warning of detectLiteralBearerWarnings(name, options.declared)) logger.warn(warning);
	const rekey = () => {
		options
			.onCredentialsChanged?.()
			.catch((error: unknown) => logger.warn("Failed to re-key MCP connection", { error }));
	};
	const renewal = mcpGenerationRenewal(
		{ serverName: name, declared: options.declared, env: session.env, agentDir: session.agentDir },
		options.generation.configHash,
		rekey,
	);
	const connectionOptions = {
		projectPolicy,
		credentialIdentity: options.credentialIdentity,
		credentialsCurrent: options.credentialsCurrent,
		authProvider: authPlan.provider,
		config,
		env: projectPolicy?.initial.env ?? session.env,
		elicitationUiProvider: options.ui,
		elicitationEnabled: options.elicitationEnabled,
		logger,
		serverName: name,
		...(renewal === undefined ? {} : { resolveConfig: renewal.resolveConfig, onGenerationChanged: rekey }),
	};
	const connection =
		options.share && session.agentDir !== undefined && shareable(config, options.cwd)
			? registry.attachShared(key, options.owner, {
					...connectionOptions,
					agentDir: session.agentDir,
					configHash: mcpConnectionIdentity(options.configHash, options.generation.configHash),
				})
			: registry.attach(key, options.owner, () => new ServerConnection(connectionOptions));
	const entry: McpConnectionEntry = {
		agentDir: session.agentDir,
		env: session.env,
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
		generationHash: mcpConnectionIdentity(options.configHash, options.generation.configHash),
		...(renewal === undefined ? {} : { generationChanged: renewal.changed }),
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
				if (entry.connection.state === "disabled") return;
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
