/**
 * Fixture for test/suite/no-sync-in-session-path.test.ts: a module shaped like a
 * session-path helper that blocks the event loop. The audit seeds it as an extra
 * call-graph root to prove the walk still fails when such a call is introduced -
 * including behind an import alias, which a text search would miss.
 *
 * Nothing imports this file at runtime.
 */
import { spawnSync as runProcessSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function fixtureBlockingProbe(): string {
	const result = runProcessSync("git", ["--version"], { encoding: "utf-8" });
	return result.stdout ?? "";
}

export function fixtureSyncRead(path: string): string {
	return readFileSync(path, "utf-8");
}

/** A caller the walk must follow to find the blocking call one level down. */
export function fixtureIndirectProbe(): string {
	return fixtureBlockingProbe();
}
