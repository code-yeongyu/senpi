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
