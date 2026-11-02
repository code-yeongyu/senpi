import type { McpOAuthProvider } from "./auth/oauth-provider.ts";
import type { McpServerConfig } from "./config-schema.ts";
import type { McpElicitationUiProvider } from "./elicitation.ts";
import type { McpLogger } from "./log.ts";
import type { ProjectMcpAuthority } from "./project-skill-policy.ts";

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
	/** `connect`: raised by every successful connect; `notification`: anything that reports a change. */
	readonly cause: "connect" | "notification";
};

export interface ServerConnectionOptions {
	readonly projectPolicy?: ProjectMcpAuthority;
	readonly credentialIdentity?: string;
	readonly credentialsCurrent?: () => boolean;
	readonly serverName: string;
	readonly config: McpServerConfig;
	readonly logger: McpLogger;
	readonly env?: Record<string, string | undefined>;
	readonly authProvider?: McpOAuthProvider;
	readonly elicitationUiProvider?: McpElicitationUiProvider;
	/** Print/json processes cannot present elicitation; UI-less lessees fail independently. */
	readonly elicitationEnabled?: boolean;
	/** Present when the server declares references: every new transport re-reads them (senpi#3858). */
	readonly resolveConfig?: () => Promise<McpServerConfig>;
	/** Called when a shared renewal finds this owner's generation changed, so the owner re-keys. */
	readonly onGenerationChanged?: () => void;
}

export type ServerConnectionListener<TEvent> = (event: TEvent) => void | Promise<void>;
