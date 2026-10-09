/**
 * Pure resolver for the test suite's agent directory.
 *
 * The quarantine MUST win over an inherited `SENPI_CODING_AGENT_DIR`: the omo
 * launcher (`omo-ai/bin/lib/launcher.js` -> `senpiEnvironment`) sets that
 * variable for every spawned child session, so a `vitest` run launched from
 * inside an omo agent session inherits a value pointing at the user's REAL
 * `~/.omo/agent`. Letting that env win ran the whole suite against the real
 * config and tests deleted `~/.omo/agent/settings.json` (observed live
 * 2026-08-18). Opt out explicitly with `SENPI_TEST_USE_REAL_AGENT_DIR=1` for
 * the rare test that must target a specific real directory.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env var suffix every brand uses for its agent-state directory override. */
const AGENT_DIR_ENV_SUFFIX = "_CODING_AGENT_DIR";
const PACKAGE_DIR_ENV_SUFFIX = "_PACKAGE_DIR";

/** Brand marker deciding which env lane wins in `brandEnvNames` (`OMO_` before `SENPI_`/`PI_`). */
const BRAND_ENV_VAR = "SENPI_BRAND";

/**
 * Remove every ambient agent-directory/package-directory lane and the brand marker from `env`.
 *
 * Quarantining only `SENPI_CODING_AGENT_DIR` is not enough: the omo launcher exports
 * `OMO_CODING_AGENT_DIR` and `SENPI_BRAND` to every session, tool children inherit both, and
 * with the omo brand active `brandEnvNames` resolves the `OMO_` lane first. The launcher also
 * exports `SENPI_PACKAGE_DIR`/`OMO_PACKAGE_DIR`; `config.ts` reads that override before locating
 * package assets, so leaving it in place makes tests load files from the installed runtime.
 * Deleting the marker plus every branded `*_CODING_AGENT_DIR` and `*_PACKAGE_DIR` lane (any
 * current or future brand) keeps the suite rooted in its checked-out package.
 */
export function scrubAmbientAgentDirEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const key of Object.keys(env)) {
		if (key.endsWith(AGENT_DIR_ENV_SUFFIX) || key.endsWith(PACKAGE_DIR_ENV_SUFFIX)) {
			delete env[key];
		}
	}
	delete env[BRAND_ENV_VAR];
}

/** Namespace of the lifecycle environment a host generation exports to everything it runs. */
const HOST_LIFECYCLE_ENV_PREFIX = "SENPI_RPC_HOST_";

/**
 * Remove every `SENPI_RPC_HOST_*` variable from `env`.
 *
 * A host generation exports its lifecycle (`SENPI_RPC_HOST_GENERATION`, `_INSTANCE_ID`, `_DAEMON_DIR`,
 * `_PUBLIC_SOCKET`, `_WATCH_PPID`, `_WATCH_FD`, `_SCRATCH_DIR`, `_CLEANUP_PATHS`; see
 * `TRANSIENT_ENV_NAMES` in `src/modes/rpc/host-daemon-env.ts`) to every session it runs, and a
 * `vitest` run started from such a session inherits all of it: protocol-identity tests then read the
 * outer host's generation, and hosts the suite spawns watch a foreign supervisor pid. Scrubbed by
 * prefix, like the agent-directory lanes, so a variable added to that list later cannot leak in; the
 * tuning variables in the same namespace (idle window, RSS threshold) go too, and a test that needs
 * one sets it explicitly.
 */
export function scrubHostLifecycleEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith(HOST_LIFECYCLE_ENV_PREFIX)) delete env[key];
	}
}

/**
 * Resolve the agent directory the test suite should run against.
 *
 * Returns a fresh unique temp directory unless an explicit opt-in
 * (`SENPI_TEST_USE_REAL_AGENT_DIR=1`) is set together with a configured
 * `SENPI_CODING_AGENT_DIR`. Returning `undefined` leaves the env var untouched.
 */
export function resolveQuarantineAgentDir(env: Record<string, string | undefined> = process.env): string | undefined {
	const explicitReal = env.SENPI_TEST_USE_REAL_AGENT_DIR === "1";
	if (explicitReal && env.SENPI_CODING_AGENT_DIR) {
		return env.SENPI_CODING_AGENT_DIR;
	}
	const quarantineDir = join(
		tmpdir(),
		`senpi-vitest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		"agent",
	);
	mkdirSync(quarantineDir, { recursive: true });
	return quarantineDir;
}
