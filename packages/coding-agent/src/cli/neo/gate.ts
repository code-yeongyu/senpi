/**
 * Feature gate for the neo (Go-native) TUI.
 *
 * The neo TUI ships as a separate Go binary distributed via per-platform npm
 * packages (`@code-yeongyu/senpi-neo-tui-<platform>-<arch>`). Those packages are
 * NOT built or published yet, so on a released senpi the `--neo` handoff can only
 * fail at binary resolution. Until the binary ships, neo stays behind an opt-in
 * env gate: OFF by default, so `--neo` and its sibling flags are absent from help
 * and parse as unknown flags (never dispatched), exactly as if the feature did not
 * exist. Set `SENPI_ENABLE_NEO=1` (or `true`/`yes`) to develop against it.
 */
export const ENV_ENABLE_NEO = "SENPI_ENABLE_NEO";

/** Whether the neo (Go TUI) flags and handoff are exposed for this process. */
export function isNeoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[ENV_ENABLE_NEO];
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
