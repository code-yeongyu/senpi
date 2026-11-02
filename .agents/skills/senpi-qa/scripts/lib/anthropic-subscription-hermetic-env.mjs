/**
 * Hermetic subprocess environment for the claude-sdk-oauth fullstack probe.
 *
 * The probe's headline guarantee is "no credentials, no network egress". The
 * ambient auth lane forwards the probe process's OWN environment to the Claude
 * Code subprocess (auth-lane.ts strips only SENPI_*), so anything inherited
 * from the developer's shell — a real ANTHROPIC_API_KEY, an OAuth token, a
 * proxy, or a competing ANTHROPIC_BASE_URL — would reach the child and could
 * route it off the loopback. This module scrubs those variables out of the
 * probe process before the pinned hermetic values are applied, then asserts the
 * result so a violated guarantee fails the run instead of silently leaking.
 */

/** Auth/routing variables that must never be inherited from the ambient shell. */
const SCRUBBED_EXACT = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"AWS_BEARER_TOKEN_BEDROCK",
	// A binary-override channel is as credential-bearing as a token: an ambient
	// CLAUDE_CODE_EXECUTABLE would make the probe launch an arbitrary binary
	// instead of the SDK-pinned one.
	"CLAUDE_CODE_EXECUTABLE",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_GATEWAY",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CONFIG_DIR",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"https_proxy",
	"http_proxy",
	"all_proxy",
];

/** Anything matching these is scrubbed too (numbered slots, stray provider keys). */
const SCRUBBED_PATTERNS = [/^CLAUDE_CODE_OAUTH_TOKEN_\d+$/, /^ANTHROPIC_.*(?:KEY|TOKEN|SECRET)$/i];

function shouldScrub(name) {
	return SCRUBBED_EXACT.includes(name) || SCRUBBED_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Remove every inherited auth/routing variable from `env`, then apply the
 * hermetic pins. Returns the names that were scrubbed so the probe can report
 * what it neutralized (names only — values are never read or logged).
 */
export function applyHermeticEnvironment(env, pinned) {
	const scrubbed = [];
	for (const name of Object.keys(env)) {
		if (!shouldScrub(name)) continue;
		scrubbed.push(name);
		delete env[name];
	}
	Object.assign(env, pinned);
	return scrubbed;
}

/**
 * Fail the run unless the subprocess environment is provably hermetic: the
 * Anthropic endpoint is the loopback server, no proxy can divert it, and the
 * only credential present is the probe's dummy.
 */
export function assertHermeticEnvironment(env, baseUrl) {
	const violations = [];
	if (env.ANTHROPIC_BASE_URL !== baseUrl) {
		violations.push(`ANTHROPIC_BASE_URL is not the loopback server (${String(env.ANTHROPIC_BASE_URL)})`);
	}
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(env.ANTHROPIC_BASE_URL))) {
		violations.push("ANTHROPIC_BASE_URL is not a 127.0.0.1 address");
	}
	for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
		if (env[name]) violations.push(`${name} is set and could divert loopback traffic`);
	}
	for (const name of Object.keys(env)) {
		if (/^CLAUDE_CODE_OAUTH_TOKEN(_\d+)?$/.test(name)) violations.push(`${name} would forward a real OAuth token`);
	}
	if (env.ANTHROPIC_AUTH_TOKEN) violations.push("ANTHROPIC_AUTH_TOKEN would forward a real credential");
	// The scrub removes CLAUDE_CODE_EXECUTABLE, but only the assertion makes the
	// guarantee enforceable: a pinned or leaked value would launch an arbitrary
	// binary instead of the SDK-pinned one.
	if (env.CLAUDE_CODE_EXECUTABLE) violations.push("CLAUDE_CODE_EXECUTABLE would launch an unpinned binary");
	if (env.ANTHROPIC_API_KEY !== undefined && !env.ANTHROPIC_API_KEY.includes("probe-dummy")) {
		violations.push("ANTHROPIC_API_KEY is not the probe's dummy value");
	}
	if (violations.length > 0) {
		throw new Error(`probe environment is not hermetic: ${violations.join("; ")}`);
	}
}
