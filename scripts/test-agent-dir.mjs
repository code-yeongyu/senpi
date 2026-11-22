#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR_ENV_SUFFIX = "_CODING_AGENT_DIR";

/**
 * Points a test run, and every process it spawns, at `<root>/agent` (senpi#3867).
 *
 * Drops every inherited `*_CODING_AGENT_DIR` lane (the omo launcher exports `OMO_` and `SENPI_`
 * lanes that name the user's real agent dir) and sets `SENPI_CODING_AGENT_DIR`. Children inherit
 * the quarantined dir, so a kernel or compiled binary a test starts never resolves the real one.
 * `SENPI_TEST_AGENT_DIR_GUARD=1` arms `getAgentDir()`'s refusal of the real dir in this tree only.
 * `SENPI_TEST_USE_REAL_AGENT_DIR=1` keeps the inherited env untouched.
 */
export function quarantineAgentDirEnv(env, root) {
	if (env.SENPI_TEST_USE_REAL_AGENT_DIR === "1") return env;
	const next = { ...env };
	for (const key of Object.keys(next)) if (key.endsWith(AGENT_DIR_ENV_SUFFIX)) delete next[key];
	const agentDir = join(root, "agent");
	// A host started on this agent dir refuses it as a key root if group or others can write it (senpi#4541).
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	next.SENPI_CODING_AGENT_DIR = agentDir;
	next.SENPI_TEST_AGENT_DIR_GUARD = "1";
	return next;
}
