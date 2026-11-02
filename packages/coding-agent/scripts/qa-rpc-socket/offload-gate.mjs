#!/usr/bin/env bun
/**
 * Applies the offload improvement thresholds to a CANDIDATE `offload-profile.mjs` report.
 *
 * Usage: bun scripts/qa-rpc-socket/offload-gate.mjs --baseline <report.json> --candidate <report.json>
 *          [--only <row>] [--functions <csv>]
 *
 * Exit 0 when every evaluated row passes, 1 when one fails, 2 on a usage error. The baseline is never
 * threshold-checked; `--functions` restricts the function-absence row to the named subset.
 */
import { readFileSync } from "node:fs";
import { evaluateGate, GATE_ROWS } from "./lib/offload-gate-rules.mjs";

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const baselinePath = flag("--baseline");
const candidatePath = flag("--candidate");
const only = flag("--only");
const functions = flag("--functions")?.split(",").filter(Boolean);
if (!baselinePath || !candidatePath || (only !== undefined && !GATE_ROWS.includes(only))) {
	process.stderr.write(`usage: offload-gate.mjs --baseline <file> --candidate <file> [--only <${GATE_ROWS.join("|")}>] [--functions <csv>]\n`);
	process.exit(2);
}
const verdict = evaluateGate({
	baseline: JSON.parse(readFileSync(baselinePath, "utf8")),
	candidate: JSON.parse(readFileSync(candidatePath, "utf8")),
	only,
	functions,
});
process.stdout.write(`${JSON.stringify(verdict, null, 1)}\n`);
process.exit(verdict.pass ? 0 : 1);
