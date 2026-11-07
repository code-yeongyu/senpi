function isClaudeOauthTokenName(name: string): boolean {
	return name === "CLAUDE_CODE_OAUTH_TOKEN" || /^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(name);
}

/**
 * Claude Code's bare mode (`claude --bare` sets it): Claude Code then authenticates only with `ANTHROPIC_API_KEY` or an
 * `apiKeyHelper` and never reads the OAuth login, so an inherited value silently takes the subscription away from every
 * lane (senpi#5132). Matched case-insensitively, as Claude Code itself clears it for its own child sessions.
 */
export function withoutBareMode<Environment extends Record<string, string | undefined>>(
	parent: Environment,
): Environment {
	const environment = { ...parent };
	for (const name of Object.keys(environment)) {
		if (name.toUpperCase() === "CLAUDE_CODE_SIMPLE") delete environment[name];
	}
	return environment;
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
	return withoutBareMode(environment);
}
