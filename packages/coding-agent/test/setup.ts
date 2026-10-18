/**
 * Vitest setup: quarantine inherited branded agent/package directory overrides so the test suite
 * never writes session JSONLs into the user's real `~/.senpi/agent/sessions/` or loads assets from
 * an installed runtime instead of this checkout.
 *
 * Many tests call `SessionManager.create(tempDir)` without an explicit
 * sessionDir. That falls back to `getDefaultSessionDir(cwd)` → `getAgentDir()`,
 * which reads this env var. If unset, it resolves to the developer's real
 * $HOME and leaves faux-provider JSONLs there permanently, where downstream
 * tools (e.g. tokscale) then mis-count them as real usage.
 */
import { dirname } from "node:path";
import { trackTempDir } from "../../../scripts/vitest-temp.ts";
import { resolveQuarantineAgentDir, scrubAmbientAgentDirEnv, scrubHostLifecycleEnv } from "./support/quarantine.ts";

// Run from inside a host generation (the normal agent case), the suite would otherwise inherit that
// host's lifecycle and hand it to every host it spawns.
scrubHostLifecycleEnv(process.env);

for (const key of ["PI_RULES_DISABLED", "PI_RULES_MAX_RULE_CHARS", "PI_RULES_MAX_RESULT_CHARS"] as const) {
	delete process.env[key];
}

const usesRealAgentDir = process.env.SENPI_TEST_USE_REAL_AGENT_DIR === "1" && !!process.env.SENPI_CODING_AGENT_DIR;
const quarantineAgentDir = resolveQuarantineAgentDir(process.env);
if (quarantineAgentDir) {
	if (!usesRealAgentDir) {
		trackTempDir(dirname(quarantineAgentDir));
	}
	// Resolve BEFORE scrubbing so the SENPI_TEST_USE_REAL_AGENT_DIR=1 opt-in still reads its
	// target; scrubbing then removes the brand marker and every other branded override, so no
	// ambient `OMO_`/`PI_` (or future-brand) value can affect config or asset resolution below.
	scrubAmbientAgentDirEnv(process.env);
	process.env.SENPI_CODING_AGENT_DIR = quarantineAgentDir;
}
