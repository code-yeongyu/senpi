/**
 * Per-run agent/log directories for tests that hand a real filesystem path to a writer.
 *
 * `createCompactionLogger(agentDir)` is not inert: `writeLine` calls the injected `sink` and then
 * still does `mkdirSync` + `openSync(..., "a")` on `<agentDir>/logs/compaction.log`, rotating it
 * with `renameSync` once it passes `maxBytes`. A hardcoded `/tmp/...` argument therefore makes every
 * test file that uses it append to — and rotate — ONE shared file: across the parallel vitest
 * workers of a single run, and across two checkouts/worktrees running the suite at the same time.
 * The signature of that hazard is a different test failing on each run.
 *
 * These helpers return a path unique per process and per call, so no two runs can collide. The
 * directory lives under the test run's `os.tmpdir()` and is removed at file teardown.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";

/**
 * Create a fresh directory usable as an `agentDir`.
 *
 * `prefix` only aids humans reading `/tmp`; uniqueness comes from `mkdtemp`, so callers never need
 * to add their own entropy.
 */
export function createTempAgentDir(prefix = "senpi-test-agent-"): string {
	return makeTempDir(join(tmpdir(), prefix));
}
