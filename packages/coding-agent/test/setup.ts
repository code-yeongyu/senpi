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
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { trackTempDir } from "../../../scripts/vitest-temp.ts";
import { installHostScratchRemovalGuard } from "./support/host-scratch-removal-guard.ts";
import { resolveQuarantineAgentDir, scrubAmbientAgentDirEnv, scrubHostLifecycleEnv } from "./support/quarantine.ts";

installHostScratchRemovalGuard();

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

// senpi#7002: the TUI login surfaces launch the platform browser by name ("open" on darwin,
// "xdg-open" on linux; src/utils/open-browser.ts), and a TUI-mode login test that forgets its
// openBrowser dep would hand the login URL to the developer's real browser. Shadow both names
// with a recording no-op first on PATH - the same always-wins boundary as the quarantine above -
// so no spawn from this suite can leave the test process. Windows launches "rundll32", which
// the loader resolves to the real System32 binary regardless of PATH: there the per-test
// openBrowser deps remain the fix, and CI's windows runners are headless.
const browserGuardDir = mkdtempSync(join(tmpdir(), "senpi-browser-guard-"));
const browserGuardRecord = join(browserGuardDir, "opened");
for (const opener of ["open", "xdg-open"]) {
	const stub = join(browserGuardDir, opener);
	writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${browserGuardRecord.replaceAll("'", `'\\''`)}'\n`, {
		mode: 0o700,
	});
	chmodSync(stub, 0o755);
}
process.env.PATH = `${browserGuardDir}${delimiter}${process.env.PATH ?? ""}`;
process.env.SENPI_TEST_BROWSER_GUARD_RECORD = browserGuardRecord;
trackTempDir(browserGuardDir);
