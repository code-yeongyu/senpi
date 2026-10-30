// SC-LIVE reporting: one PASS/FAIL line per invariant, and the run's evidence (receipt, RPC events, transcript) under
// local-ignore/qa-evidence/<date>-<slug>/. Headers in receipts are already sanitized by the recording proxy; no credential value
// reaches any file written here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../../../../scripts/lib/common.mjs";

export function printChecks(label, verdict) {
	for (const c of verdict.checks)
		process.stdout.write(
			`[${c.pass ? "PASS" : "FAIL"}] ${label} ${c.id}: ${Array.isArray(c.detail) ? c.detail.join("; ") : c.detail}\n`,
		);
}

export function writeEvidence(slug, receipt, session) {
	const out = evidenceDir(slug);
	writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 1)}\n`);
	if (session) {
		writeFileSync(join(out, "events.jsonl"), `${session.events.map((e) => JSON.stringify(e)).join("\n")}\n`);
		writeFileSync(join(out, "transcript.jsonl"), `${session.entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}
	return out;
}
