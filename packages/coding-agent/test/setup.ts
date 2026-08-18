/**
 * Vitest setup: quarantine SENPI_CODING_AGENT_DIR so the test suite never
 * writes session JSONLs into the user's real `~/.senpi/agent/sessions/`.
 *
 * Many tests call `SessionManager.create(tempDir)` without an explicit
 * sessionDir. That falls back to `getDefaultSessionDir(cwd)` → `getAgentDir()`,
 * which reads this env var. If unset, it resolves to the developer's real
 * $HOME and leaves faux-provider JSONLs there permanently, where downstream
 * tools (e.g. tokscale) then mis-count them as real usage.
 */
import { resolveQuarantineAgentDir } from "./support/quarantine.ts";

for (const key of ["PI_RULES_DISABLED", "PI_RULES_MAX_RULE_CHARS", "PI_RULES_MAX_RESULT_CHARS"] as const) {
	delete process.env[key];
}

const quarantineAgentDir = resolveQuarantineAgentDir(process.env);
if (quarantineAgentDir) {
	process.env.SENPI_CODING_AGENT_DIR = quarantineAgentDir;
}
