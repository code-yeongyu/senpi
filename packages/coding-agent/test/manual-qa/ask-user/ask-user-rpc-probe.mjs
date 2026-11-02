#!/usr/bin/env node
/**
 * ask-user RPC end-to-end probe (plan todo 23).
 *
 * Usage (from anywhere; run with node, the CLI child is spawned through tsx):
 *   node test/manual-qa/ask-user/ask-user-rpc-probe.mjs [--scenario main|hydration|async|resume|owner-drop|all] [--out <jsonl>]
 *
 * `main` (default) = hydration + async + resume: the green gate. `owner-drop`
 * and `all` additionally run the declared-defect scenario. Exit 0 iff every
 * scenario ends with zero failures and every declared defect was observed
 * exactly as declared (a fixed defect fails the run until its declaration is
 * removed).
 */

import { runAsyncTimeout } from "./scenario-async-timeout.mjs";
import { runHydration } from "./scenario-hydration.mjs";
import { runOwnerDrop } from "./scenario-owner-drop.mjs";
import { runResume } from "./scenario-resume.mjs";
import { createReport } from "./lib/report.mjs";

const flag = (name) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};

const SCENARIOS = {
	hydration: runHydration,
	async: runAsyncTimeout,
	resume: runResume,
	"owner-drop": runOwnerDrop,
};

function resolveScenarios() {
	const requested = flag("--scenario") ?? "main";
	if (requested === "main") return ["hydration", "async", "resume"];
	if (requested === "all") return ["hydration", "async", "resume", "owner-drop"];
	if (SCENARIOS[requested]) return [requested];
	throw new Error(`unknown --scenario ${requested}; use main|hydration|async|resume|owner-drop|all`);
}

async function main() {
	const out = flag("--out");
	let ok = true;
	for (const name of resolveScenarios()) {
		const report = createReport(name, { out: out ? `${out}.${name}` : undefined });
		process.stdout.write(`\n=== scenario ${name} ===\n`);
		const completed = await SCENARIOS[name](report);
		const summary = report.finish();
		ok = ok && completed && summary.ok;
	}
	process.stdout.write(`\n=== probe ${ok ? "GREEN" : "RED"} ===\n`);
	process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exit(1);
});
