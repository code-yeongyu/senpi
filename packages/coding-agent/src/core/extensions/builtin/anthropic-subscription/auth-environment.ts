import type { AnthropicSubscriptionAmbientApiKey } from "./settings.ts";

function isClaudeOauthTokenName(name: string): boolean {
	return name === "CLAUDE_CODE_OAUTH_TOKEN" || /^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(name);
}

export function hasRequestOauthToken(requestEnvironment: Record<string, string> | undefined): boolean {
	return Object.entries(requestEnvironment ?? {}).some(
		([name, value]) => isClaudeOauthTokenName(name) && Boolean(value),
	);
}

export function mergeRequestAuthEnvironment(
	hostEnvironment: NodeJS.ProcessEnv,
	requestEnvironment: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
	const environment = { ...hostEnvironment };
	const requestTokens = Object.entries(requestEnvironment ?? {}).filter(([name]) => isClaudeOauthTokenName(name));
	if (requestTokens.length === 0) return environment;
	for (const name of Object.keys(environment)) {
		if (isClaudeOauthTokenName(name)) delete environment[name];
	}
	for (const [name, value] of requestTokens) environment[name] = value;
	return environment;
}

/**
 * Whether the ambient lane hands Claude Code the host ANTHROPIC_API_KEY. A key outranks the claude.ai login inside
 * Claude Code and bills the console org instead of the subscription (senpi#1195), so it is dropped unless the user
 * chose `inherit`, or it is the credential of an x-api-key gateway (ANTHROPIC_BASE_URL set, no ANTHROPIC_AUTH_TOKEN):
 * dropping that one leaves the gateway with no credential, or sends the claude.ai bearer to a third-party host.
 */
export function keepsAmbientApiKey(parent: NodeJS.ProcessEnv, policy: AnthropicSubscriptionAmbientApiKey): boolean {
	if (policy === "inherit") return true;
	return isGatewayBaseUrl(parent.ANTHROPIC_BASE_URL) && !parent.ANTHROPIC_AUTH_TOKEN;
}

const DEFAULT_ANTHROPIC_ORIGIN = "https://api.anthropic.com";

/**
 * A base URL on Anthropic's own origin (any path or trailing slash) is not a gateway: the key there would bill the
 * console org exactly as in senpi#1195, and the claude.ai bearer goes where it always goes. A value that does not
 * parse as a URL is kept as a gateway, because it cannot be shown to be Anthropic's origin.
 */
function isGatewayBaseUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		return new URL(value).origin !== DEFAULT_ANTHROPIC_ORIGIN;
	} catch {
		return true;
	}
}

/** The host key the ambient lane drops, named for the diagnostic when the probe then finds no login. */
export function ignoredAmbientApiKey(
	parent: NodeJS.ProcessEnv,
	policy: AnthropicSubscriptionAmbientApiKey,
): "ANTHROPIC_API_KEY" | undefined {
	return parent.ANTHROPIC_API_KEY && !keepsAmbientApiKey(parent, policy) ? "ANTHROPIC_API_KEY" : undefined;
}

/**
 * The ambient child environment, shared by the `claude auth status` probe and the turn lane so availability and the
 * turn cannot disagree: the host's own login and gateway settings minus the SENPI_* namespace, and minus the host
 * ANTHROPIC_API_KEY unless `keepsAmbientApiKey` keeps it.
 */
export function stripAmbientApiKey(
	parent: NodeJS.ProcessEnv,
	policy: AnthropicSubscriptionAmbientApiKey,
): NodeJS.ProcessEnv {
	const environment = { ...parent };
	if (!keepsAmbientApiKey(parent, policy)) delete environment.ANTHROPIC_API_KEY;
	for (const name of Object.keys(environment)) {
		if (name.startsWith("SENPI_")) delete environment[name];
	}
	return environment;
}

export function stripManagedAuthEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const {
		ANTHROPIC_API_KEY: _apiKey,
		ANTHROPIC_AUTH_TOKEN: _authToken,
		ANTHROPIC_BASE_URL: _gateway,
		ANTHROPIC_CUSTOM_HEADERS: _customHeaders,
		CLAUDE_CODE_OAUTH_TOKEN: _oauthToken,
		CLAUDE_CODE_USE_BEDROCK: _bedrock,
		CLAUDE_CODE_USE_FOUNDRY: _foundry,
		CLAUDE_CODE_USE_GATEWAY: _gatewayMode,
		CLAUDE_CODE_USE_VERTEX: _vertex,
		...environment
	} = parent;
	for (const name of Object.keys(environment)) {
		if (/^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(name)) delete environment[name];
		if (name.startsWith("SENPI_")) delete environment[name];
	}
	return environment;
}
