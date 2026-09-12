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
