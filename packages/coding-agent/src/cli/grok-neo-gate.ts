/**
 * Feature gate for the grok-neo interactive chrome.
 *
 * The grok chrome is experimental, so its `--grok-neo` handoff stays behind an
 * opt-in env gate: OFF by default, the flag is absent from help and parses as
 * an unknown extension flag, exactly as if the feature did not exist. Set
 * `SENPI_ENABLE_GROK_NEO=1` (or `true`/`yes`) to enable it.
 */
export const ENV_ENABLE_GROK_NEO = "SENPI_ENABLE_GROK_NEO";

/** Whether the experimental grok-neo CLI flag is exposed for this process. */
export function isGrokNeoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[ENV_ENABLE_GROK_NEO];
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
