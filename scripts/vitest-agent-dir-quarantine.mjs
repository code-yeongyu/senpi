import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { quarantineAgentDirEnv } from "./test-agent-dir.mjs";

/**
 * Quarantines the agent dir for a Vitest run that scripts/run-tests.mjs did not start (the codemode
 * gate calls Vitest directly), before workers fork, so every worker and the kernels or CLIs they spawn
 * inherit a temp dir (senpi#3867). Imported only by unit-test configs, never by the shared
 * vitest.base.ts: the evals configs import that base and must keep reading the real agent dir.
 */
export function quarantineVitestAgentDir(env = process.env) {
	const inheritedAgentDirs = Object.entries(env).filter(([key]) => key.endsWith("_CODING_AGENT_DIR"));
	const alreadyQuarantined =
		env.SENPI_TEST_AGENT_DIR_GUARD === "1" && inheritedAgentDirs.every(([, dir]) => dir?.startsWith(tmpdir() + sep) === true);
	if (alreadyQuarantined || env.SENPI_TEST_USE_REAL_AGENT_DIR === "1") return;
	const agentRoot = mkdtempSync(join(tmpdir(), "senpi-vitest-agent-"));
	process.once("exit", () => rmSync(agentRoot, { recursive: true, force: true }));
	const quarantined = quarantineAgentDirEnv(env, agentRoot);
	for (const key of Object.keys(env)) if (!(key in quarantined)) delete env[key];
	Object.assign(env, quarantined);
}
