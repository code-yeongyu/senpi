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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of ["PI_RULES_DISABLED", "PI_RULES_MAX_RULE_CHARS", "PI_RULES_MAX_RESULT_CHARS"] as const) {
	delete process.env[key];
}

// Guarded so an explicit `SENPI_CODING_AGENT_DIR=...` env (CI / opt-in) wins.
if (!process.env.SENPI_CODING_AGENT_DIR) {
	const sharedQuarantineRoot = process.env.SENPI_VITEST_QUARANTINE_ROOT;
	const quarantineRoot = sharedQuarantineRoot ?? mkdtempSync(join(tmpdir(), "senpi-vitest-"));
	const workerRoot = sharedQuarantineRoot
		? mkdtempSync(join(sharedQuarantineRoot, `worker-${process.pid}-`))
		: quarantineRoot;
	const quarantineDir = join(workerRoot, "agent");
	mkdirSync(quarantineDir, { recursive: true });
	process.env.SENPI_CODING_AGENT_DIR = quarantineDir;
	if (!sharedQuarantineRoot) {
		process.once("exit", () => {
			rmSync(quarantineRoot, { recursive: true, force: true });
		});
	}
}
