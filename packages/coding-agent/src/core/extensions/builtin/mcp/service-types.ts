import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "../../types.ts";
import type { ServerAuthPlan } from "./auth/context.ts";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { ResolvedMcpServer } from "./config-schema.ts";
import type { ServerConnection, ServerConnectionState } from "./connection.ts";
import type { McpLogger } from "./log.ts";

export type McpDisposeReason = Extract<SessionShutdownEvent["reason"], "quit" | "reload">;
export type McpSessionContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export interface McpSessionOptions {
	readonly agentDir?: string;
	readonly env?: Record<string, string | undefined>;
	readonly logDir?: string;
	readonly projectTrusted?: boolean;
}

export interface McpServiceSnapshot {
	disposed: boolean;
	disposeCount: number;
	lastDisposeReason: McpDisposeReason | null;
	sessionStartCount: number;
	lastSessionStartReason: SessionStartEvent["reason"] | null;
	hasSessionContext: boolean;
	connectionCount: number;
}

export interface McpServerSnapshot {
	name: string;
	configState: ResolvedMcpServer["state"] | "removed";
	configHash: string | null;
	sourcePath: string | null;
	lifecycleState: ServerConnectionState | "cached" | "not_spawned";
	generation: number | null;
	pid: number | null;
	lastError: string | null;
	uptimeMs: number | null;
	counters: McpServerCounters;
}

export interface McpServerCounters {
	callCount: number;
	errorCount: number;
	totalLatencyMs: number;
	reconnectCount: number;
}

export interface McpConnectionEntry {
	readonly key: string;
	readonly name: string;
	readonly configHash: string;
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
	readonly createdAtMs: number;
	readonly counters: McpServerCounters;
	readonly agentDir?: string;
	readonly authPlan?: ServerAuthPlan;
	cachedCatalog?: McpCachedServerCatalog;
	cacheRefreshedAfterConnect: boolean;
}
