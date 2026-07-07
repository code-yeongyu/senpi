import type { McpServerConfig } from "../config-schema.ts";
import type { McpLogger } from "../log.ts";
import { fingerprintSecret } from "../log.ts";
import { McpOAuthProvider } from "./oauth-provider.ts";
import { McpRefreshManager } from "./oauth-refresh.ts";
import { McpTokenStore } from "./token-store.ts";

export type ServerAuthMode = "none" | "bearer" | "oauth";

// Placeholder loopback redirect for background (non-interactive) connects; the
// real callback URL is supplied by /mcp auth. Never actually dereferenced.
const BACKGROUND_REDIRECT = "http://127.0.0.1:0/callback";

export interface ServerAuthDeps {
	serverName: string;
	config: McpServerConfig;
	agentDir?: string;
	env?: Record<string, string | undefined>;
	logger?: McpLogger;
	redirectUrl?: string | URL;
	onRedirect?: (url: URL) => void | Promise<void>;
}

export interface ServerAuthPlan {
	mode: ServerAuthMode;
	provider?: McpOAuthProvider;
	refresh?: McpRefreshManager;
}

// OAuth autodetect (#158): headers or an explicit non-oauth `auth` disable it so
// API-key servers never trigger DCR/discovery.
export function resolveAuthMode(config: McpServerConfig): ServerAuthMode {
	if (config.auth === "oauth") return "oauth";
	if (config.auth === false) return "none";
	if (config.auth === "bearer" || config.bearerTokenEnv !== undefined) return "bearer";
	if (config.headers !== undefined && Object.keys(config.headers).length > 0) return "none";
	if (config.type === "http" && typeof config.url === "string" && config.url.length > 0) return "oauth";
	return "none";
}

export function resolveServerAuth(deps: ServerAuthDeps): ServerAuthPlan {
	const mode = resolveAuthMode(deps.config);
	if (mode !== "oauth") return { mode };
	const serverUrl = deps.config.url ?? "";
	const store = new McpTokenStore({ agentDir: deps.agentDir, serverName: deps.serverName, serverUrl });
	const provider = new McpOAuthProvider({
		serverName: deps.serverName,
		serverUrl,
		store,
		// A redirect URL must be present so the SDK selects the authorization-code
		// flow and raises UnauthorizedError (-> needs_auth) on a token-less connect,
		// rather than falling through to a client_credentials token request.
		redirectUrl: deps.redirectUrl ?? BACKGROUND_REDIRECT,
		scopes: deps.config.oauth?.scopes,
		clientId: deps.config.oauth?.clientId,
		clientMetadataUrl: deps.config.oauth?.clientMetadataUrl,
		logger: deps.logger,
		onRedirect: deps.onRedirect,
	});
	return { mode, provider, refresh: new McpRefreshManager(provider) };
}

const LITERAL_SECRET = /(?:bearer\s+\S|sk-[a-z0-9]|[a-z0-9]{24,})/i;

// Warn (never block) when a plaintext token is embedded in headers instead of a
// ${VAR} reference. Emits fingerprints only, never the raw value.
export function detectLiteralBearerWarnings(serverName: string, config: McpServerConfig): string[] {
	const warnings: string[] = [];
	for (const [header, value] of Object.entries(config.headers ?? {})) {
		if (value.includes("${")) continue;
		if (LITERAL_SECRET.test(value)) {
			warnings.push(
				`MCP server ${serverName} header '${header}' appears to contain a literal secret (fp ${fingerprintSecret(value)}); use \${ENV_VAR} so the token stays out of the config file.`,
			);
		}
	}
	return warnings;
}
