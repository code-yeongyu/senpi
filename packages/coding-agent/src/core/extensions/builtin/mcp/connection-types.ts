import type { McpOAuthProvider } from "./auth/oauth-provider.ts";
import type { McpServerConfig } from "./config-schema.ts";
import type { McpLogger } from "./log.ts";

export type ServerConnectionState =
	| "disabled"
	| "idle"
	| "connecting"
	| "connected"
	| "degraded"
	| "suspended"
	| "needs_auth"
	| "needs_client_registration";

export type ServerConnectionStateChangedEvent = {
	readonly type: "state_changed";
	readonly serverName: string;
	readonly generation: number;
	readonly state: ServerConnectionState;
	readonly previousState: ServerConnectionState;
	readonly error?: Error;
};

export type ServerConnectionToolsChangedEvent = {
	readonly type: "tools_changed";
	readonly serverName: string;
	readonly generation: number;
};

export interface ServerConnectionOptions {
	readonly serverName: string;
	readonly config: McpServerConfig;
	readonly logger: McpLogger;
	readonly env?: Record<string, string | undefined>;
	readonly authProvider?: McpOAuthProvider;
}

export type ServerConnectionListener<TEvent> = (event: TEvent) => void | Promise<void>;
