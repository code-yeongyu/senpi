/**
 * Feature gate for the grok-neo interactive chrome.
 *
 * The grok chrome is experimental, so its `--grok-neo` handoff stays behind an
 * opt-in env gate: OFF by default, the flag is absent from help and parses as
 * an unknown extension flag, exactly as if the feature did not exist. Set
 * `<PREFIX>_ENABLE_GROK_NEO=1` (or `true`/`yes`) to enable it, where the prefix is the
 * running product's own prefix; the legacy `SENPI_`/`PI_` names keep working.
 */
import { envValue } from "../core/brand.ts";

export const ENV_ENABLE_GROK_NEO = "SENPI_ENABLE_GROK_NEO";

/** Whether the experimental grok-neo CLI flag is exposed for this process. */
export function isGrokNeoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = envValue("ENABLE_GROK_NEO", env);
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
