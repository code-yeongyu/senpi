// SC-LIVE reporting: one PASS/FAIL line per invariant, and the run's evidence (receipt, RPC events, transcript) under
// local-ignore/qa-evidence/<date>-<slug>/. Headers in receipts are already sanitized by the recording proxy; no credential value
// reaches any file written here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../../../../scripts/lib/common.mjs";

export function printChecks(label, verdict) {
	for (const c of verdict.checks) {
		process.stdout.write(
			`[${c.pass ? "PASS" : "FAIL"}] ${label} ${c.id}: ${Array.isArray(c.detail) ? c.detail.join("; ") : c.detail}\n`,
		);
		// A passing G1 names its exclusions in detail; a failing one lists only failures, so name them here too.
		if (!c.pass && c.excluded?.count)
			process.stdout.write(`       ${c.id} excluded ${c.excluded.count} ${c.excluded.origin} session(s): ${c.excluded.sessions.join(", ")}\n`);
	}
}

export function writeEvidence(slug, receipt, session) {
	const out = evidenceDir(slug);
	writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 1)}\n`);
	if (session) {
		writeFileSync(join(out, "events.jsonl"), `${session.events.map((e) => JSON.stringify(e)).join("\n")}\n`);
		writeFileSync(join(out, "transcript.jsonl"), `${session.entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
		writeFileSync(join(out, "hook-trace.jsonl"), session.hookTrace);
		const manifest = (session.sessionTranscripts ?? []).map((transcript, index) => {
			// Flat names also survive the live runner's non-recursive evidence copy.
			const file = `session-${index}.jsonl`;
			writeFileSync(join(out, file), transcript.text);
			return { session_id: transcript.entries[0].id, path: transcript.path, file };
		});
		writeFileSync(join(out, "sessions.json"), `${JSON.stringify({
			sessions: manifest, skippedPaths: session.skippedSessionPaths ?? [],
		}, null, 1)}\n`);
	}
	return out;
}
