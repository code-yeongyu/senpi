#!/usr/bin/env node
/**
 * Real-CLI QA for https://github.com/code-yeongyu/senpi/issues/887.
 *
 * Surface: `senpi update --models`, the only production path that forces a
 * networked catalog refresh (package-manager-cli.ts refreshModelCatalogs,
 * allowNetwork: true + force: true). With an opengateway credential configured,
 * the pre-fix runtime wraps the fork-only provider with the pi.dev remote
 * catalog, the fetch fails (upstream cannot serve the id), and the command
 * exits 1 naming opengateway. Post-fix the provider has no refreshModels under
 * the default catalog base URL, so it is skipped and the command exits 0.
 *
 * Default mode asserts the FIXED behavior. `--mode broken` asserts the pre-fix
 * failure when run from an unfixed checkout.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/fork-only-catalog-skip-qa.mjs --evidence fork-only-catalog-skip
 *   node .agents/skills/senpi-qa/scripts/scenarios/fork-only-catalog-skip-qa.mjs --mode broken --evidence fork-only-catalog-skip-broken
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
	stripAnsi,
} from "../lib/common.mjs";

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

const mode = arg("--mode", "fixed");
const evidence = arg("--evidence", undefined);
if (mode !== "fixed" && mode !== "broken") {
	throw new Error(`Unknown --mode: ${mode}`);
}

const checks = createChecks(`fork-only-catalog-skip-qa (${mode})`);
const guard = guardRealAuth();
installCleanupHooks();

const box = makeSandbox("fork-only-catalog-skip");
writeFileSync(
	join(box.agentDir, "auth.json"),
	JSON.stringify({ opengateway: { type: "api_key", key: "qa-fake-opengateway-key" } }),
	{ mode: 0o600 },
);

const result = await runCli(["update", "--models"], { env: box.env, cwd: box.cwd, timeoutMs: 45_000 });
const output = stripAnsi(`${result.stdout}\n${result.stderr}`);

if (evidence) {
	const dir = evidenceDir(evidence);
	writeFileSync(join(dir, `update-models-${mode}.txt`), `exit=${result.code} timedOut=${result.timedOut}\n\n${output}`);
}

checks.ok("CLI completed without harness timeout", !result.timedOut, `code=${result.code}`);
if (mode === "fixed") {
	checks.ok("update --models exits 0", result.code === 0, `code=${result.code}\n${output.slice(-800)}`);
	checks.ok(
		"catalogs refreshed successfully",
		output.includes("Model catalogs refreshed"),
		output.slice(-400),
	);
	checks.ok(
		"no opengateway refresh failure",
		!output.includes("opengateway"),
		output.slice(-400),
	);
} else {
	checks.ok("update --models fails pre-fix", result.code !== 0, `code=${result.code}`);
	checks.ok(
		"failure names the catalog refresh problem",
		/opengateway|timed out/i.test(output),
		output.slice(-400),
	);
}
checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);

process.exit(checks.finish() ? 0 : 1);
