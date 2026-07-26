import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "../../types.ts";
import type { ServerAuthPlan } from "./auth/context.ts";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { ResolvedMcpServer } from "./config-schema.ts";
import type { ServerConnection, ServerConnectionState } from "./connection.ts";
import type { McpOutputArtifacts } from "./guard/output-guard.ts";
import type { McpLogger } from "./log.ts";

export type McpDisposeReason = Extract<SessionShutdownEvent["reason"], "quit" | "reload">;

export type McpWireJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly McpWireJsonValue[]
	| { readonly [key: string]: McpWireJsonValue | undefined };

export type McpWireAuthStatus = "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";

export type McpWireServerInfo = {
	readonly name: string;
	readonly title: string | null;
	readonly version: string;
	readonly description: string | null;
	readonly icons: readonly McpWireJsonValue[] | null;
	readonly websiteUrl: string | null;
};

export type McpWireTool = {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema: McpWireJsonValue;
	readonly outputSchema?: McpWireJsonValue;
	readonly annotations?: McpWireJsonValue;
	readonly icons?: readonly McpWireJsonValue[];
	readonly _meta?: McpWireJsonValue;
};

export type McpWireResource = {
	readonly annotations?: McpWireJsonValue;
	readonly description?: string;
	readonly mimeType?: string;
	readonly name: string;
	readonly size?: number;
	readonly title?: string;
	readonly uri: string;
	readonly icons?: readonly McpWireJsonValue[];
	readonly _meta?: McpWireJsonValue;
};

export type McpWireResourceTemplate = {
	readonly annotations?: McpWireJsonValue;
	readonly uriTemplate: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly icons?: readonly McpWireJsonValue[];
	readonly _meta?: McpWireJsonValue;
};

export type McpWireStatusServer = {
	readonly name: string;
	readonly serverInfo: McpWireServerInfo | null;
	readonly tools: readonly McpWireTool[];
	readonly resources: readonly McpWireResource[];
	readonly resourceTemplates: readonly McpWireResourceTemplate[];
	readonly authStatus: McpWireAuthStatus;
};

export type McpWireStatusSnapshot = {
	readonly servers: readonly McpWireStatusServer[];
};

export type McpSessionContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted"> & {
	mode?: ExtensionContext["mode"];
	/**
	 * Session history access, present on the real ExtensionContext. Only
	 * getEntries is needed (attach-time promotion rehydration); keeping the
	 * requirement narrow lets tests pass a two-line fake.
	 */
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getEntries"> &
		Partial<Pick<ExtensionContext["sessionManager"], "getSessionId">>;
	/**
	 * Extension-declared MCP servers. Read on every attach so reattach/reload
	 * paths pick up the current declarations without caching them in the MCP
	 * builtin.
	 */
	getRegisteredMcpServers?: () => readonly {
		name: string;
		config: Record<string, unknown>;
		extensionPath: string;
		registrationCwd: string;
	}[];
};

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
	source: ResolvedMcpServer["source"] | null;
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
	readonly artifacts?: McpOutputArtifacts;
	readonly authPlan?: ServerAuthPlan;
	cachedCatalog?: McpCachedServerCatalog;
	cacheRefreshedAfterConnect: boolean;
	/** Full mcp tool names last registered for this server (list_changed diffing). */
	knownToolNames?: string[];
	/** Latest `/mcp status` list_changed delta line, e.g. "2 added (inactive), 1 removed". */
	lastListChangedDelta?: string;
	/** Teardown for the list_changed coalescer + subscription. */
	disposeListChanged?: () => void;
}
