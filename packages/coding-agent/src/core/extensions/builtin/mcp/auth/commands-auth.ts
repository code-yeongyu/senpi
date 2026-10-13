import type { McpServerConfig } from "../config-schema.ts";
import type { McpLogger } from "../log.ts";
import { openCallbackChannel } from "./callback.ts";
import { resolveServerAuth } from "./context.ts";
import type { OAuthFlowOptions } from "./oauth.ts";
import {
	beginAuthorization,
	clientCredentialsGrant,
	completeAuthorization,
	finishAuthorization,
	logout,
} from "./oauth.ts";
import { OAuthFlowError } from "./oauth-errors.ts";
import type { McpOAuthProvider } from "./oauth-provider.ts";

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

export interface AuthCommandDeps {
	serverName: string;
	config: McpServerConfig;
	agentDir?: string;
	env?: Record<string, string | undefined>;
	logger?: McpLogger;
	hasUI: boolean;
	notify: Notify;
	// settings.oauthCallbackUrl override: when set, no local listener is opened.
	callbackUrl?: string;
	openBrowser?: (url: URL) => void | Promise<void>;
	onReconnect: () => Promise<void>;
	// Persists the provider between auth-start and auth-complete so the in-memory
	// CSRF state survives across two command invocations in one session.
	pending: Map<string, McpOAuthProvider>;
	/** Per-service guard: the same server may authenticate in another session. */
	interactiveGuard?: { begin(serverName: string): boolean; end(serverName: string): void };
	flow?: OAuthFlowOptions;
}

const PASTE_REDIRECT = "http://127.0.0.1:0/callback";
const activeInteractiveAuthServers = new Set<string>();

function ensureOAuth(deps: AuthCommandDeps): void {
	if (deps.config.auth === false || deps.config.type !== "http" || deps.config.url === undefined) {
		throw new OAuthFlowError("headless", `MCP server ${deps.serverName} is not an OAuth HTTP server.`, {
			serverName: deps.serverName,
		});
	}
}

function buildProvider(
	deps: AuthCommandDeps,
	redirectUrl: string,
	onRedirect?: (url: URL) => void | Promise<void>,
): McpOAuthProvider {
	const plan = resolveServerAuth({
		agentDir: deps.agentDir,
		config: { ...deps.config, auth: "oauth" },
		env: deps.env,
		logger: deps.logger,
		onRedirect,
		redirectUrl,
		serverName: deps.serverName,
	});
	if (plan.provider === undefined) {
		throw new OAuthFlowError("headless", `MCP server ${deps.serverName} could not build an OAuth provider.`, {
			serverName: deps.serverName,
		});
	}
	return plan.provider;
}

// A stored dynamic registration names the redirect URI it was created with. A
// flow may bind another one (background placeholder vs. interactive loopback
// port), and authorization servers that validate `redirect_uri` exactly reject
// the mismatch with "Invalid redirect URI", so drop such a registration and let
// the SDK register one that matches this flow.
async function dropStaleRegistration(provider: McpOAuthProvider, redirectUrl: string): Promise<void> {
	const info = provider.clientInformation();
	const redirectUris = info === undefined ? undefined : "redirect_uris" in info ? info.redirect_uris : undefined;
	if (
		redirectUris !== undefined &&
		redirectUris.length > 0 &&
		!redirectUris.some((uri) => String(uri) === String(redirectUrl))
	) {
		await provider.invalidateCredentials("client");
	}
}

// `/mcp auth <server>`: client_credentials M2M, or interactive loopback flow.
// Non-UI callers fail fast with an actionable headless hint (no browser).
export async function runAuth(deps: AuthCommandDeps): Promise<void> {
	ensureOAuth(deps);
	if (deps.config.oauth?.flow === "client_credentials") {
		const provider = buildProvider(deps, deps.callbackUrl ?? PASTE_REDIRECT);
		await clientCredentialsGrant(provider, deps.flow);
		await deps.onReconnect();
		deps.notify(`MCP server ${deps.serverName} authenticated (client_credentials)`);
		return;
	}
	if (!deps.hasUI) {
		deps.notify(
			`MCP server ${deps.serverName} needs interactive OAuth. Run senpi in a terminal, then: /mcp auth-start ${deps.serverName}  and  /mcp auth-complete ${deps.serverName} <redirect-url>`,
			"error",
		);
		return;
	}
	await runInteractive(deps);
}

async function runInteractive(deps: AuthCommandDeps): Promise<void> {
	const beginInteractiveAuth =
		deps.interactiveGuard?.begin(deps.serverName) ?? !activeInteractiveAuthServers.has(deps.serverName);
	if (!beginInteractiveAuth) {
		throw new OAuthFlowError(
			"needs_auth",
			`MCP server ${deps.serverName} authorization is already in progress; complete the existing browser flow or retry after it finishes.`,
			{ serverName: deps.serverName },
		);
	}
	if (deps.interactiveGuard === undefined) activeInteractiveAuthServers.add(deps.serverName);
	let provider: McpOAuthProvider | undefined;
	let channel: Awaited<ReturnType<typeof openCallbackChannel>> | undefined;
	const oauth = deps.config.oauth;
	let callbackPort: number | undefined;
	if (
		(deps.callbackUrl === undefined || deps.callbackUrl.length === 0) &&
		oauth?.clientId !== undefined &&
		oauth.clientMetadataUrl === undefined
	) {
		callbackPort = oauth.callbackPort;
	}
	try {
		channel = await openCallbackChannel({
			overrideUrl: deps.callbackUrl,
			port: callbackPort,
			serverName: deps.serverName,
			validateState: (state) => provider?.consumeState(state) ?? false,
		});
		const loopbackResult = channel.usesLoopback ? channel.waitForCode() : undefined;
		const usesLoopback = channel.usesLoopback;
		provider = buildProvider(deps, channel.redirectUrl, async (url) => {
			const instruction = usesLoopback
				? ""
				: `\nThen run /mcp auth-complete ${deps.serverName} <redirect-url> with the final redirect URL.`;
			const announcement = `Open this URL to authorize ${deps.serverName}:\n${url.toString()}${instruction}`;
			deps.notify(announcement);
			try {
				await deps.openBrowser?.(url);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.notify(`Browser launch failed: ${message}\n${announcement}`, "warning");
			}
		});
		await dropStaleRegistration(provider, channel.redirectUrl);
		const begin = await beginAuthorization(provider, deps.flow);
		if (!channel.usesLoopback) {
			deps.pending.set(deps.serverName, provider);
			if (begin.authorizationUrl === undefined) {
				throw new OAuthFlowError(
					"needs_auth",
					`MCP server ${deps.serverName} did not produce an authorization URL.`,
					{
						serverName: deps.serverName,
					},
				);
			}
			return;
		}
		const { code, iss } = await (loopbackResult ?? channel.waitForCode());
		await finishAuthorization(provider, code, deps.flow, iss);
		await deps.onReconnect();
		deps.notify(`MCP server ${deps.serverName} authorized`);
	} finally {
		if (deps.interactiveGuard) deps.interactiveGuard.end(deps.serverName);
		else activeInteractiveAuthServers.delete(deps.serverName);
		await channel?.close();
	}
}

// `/mcp auth-start <server>`: print the authorize URL for a browser-less paste.
export async function runAuthStart(deps: AuthCommandDeps): Promise<string> {
	ensureOAuth(deps);
	const provider = buildProvider(deps, deps.callbackUrl ?? PASTE_REDIRECT);
	await dropStaleRegistration(provider, deps.callbackUrl ?? PASTE_REDIRECT);
	const begin = await beginAuthorization(provider, deps.flow);
	const url = begin.authorizationUrl;
	if (url === undefined) {
		throw new OAuthFlowError("needs_auth", `MCP server ${deps.serverName} did not produce an authorization URL.`, {
			serverName: deps.serverName,
		});
	}
	deps.pending.set(deps.serverName, provider);
	deps.notify(
		`Open this URL, approve, then run /mcp auth-complete ${deps.serverName} <redirect-url>:\n${url.toString()}`,
	);
	return url.toString();
}

// `/mcp auth-complete <server> <redirect-url>`: finish the paste flow.
export async function runAuthComplete(deps: AuthCommandDeps, redirectUrl: string): Promise<void> {
	ensureOAuth(deps);
	const pending = deps.pending.get(deps.serverName);
	const provider = pending ?? buildProvider(deps, deps.callbackUrl ?? PASTE_REDIRECT);
	await completeAuthorization(provider, redirectUrl, deps.flow);
	deps.pending.delete(deps.serverName);
	await deps.onReconnect();
	deps.notify(`MCP server ${deps.serverName} authorized`);
}

// `/mcp logout <server>`: clear stored credentials.
export async function runLogout(deps: AuthCommandDeps): Promise<void> {
	const provider = buildProvider(deps, PASTE_REDIRECT);
	await logout(provider);
	deps.pending.delete(deps.serverName);
	await deps.onReconnect();
	deps.notify(`MCP server ${deps.serverName} logged out`);
}
