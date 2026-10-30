// Deferred golden cells (scenarios/fused-equivalence/deferred-goldens.mjs): how the EQ harness treats a listed cell.
//
// A cell is { platform, case, mode }, with mode "rpc" (golden/<platform>/<case>.json) or "tui"
// (golden-tui/<platform>/<case>.json). The verdicts:
//   - golden exists                    -> compare it (a listed cell whose golden exists is STALE and fails the run)
//   - golden missing, cell listed      -> DEFERRED(<owner>, <issue>): never a PASS, never a failure
//   - golden missing, cell not listed  -> missing: the case FAILS
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EQ_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios", "fused-equivalence");
const MODES = ["rpc", "tui"];
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/;

const cellKey = (entry) => `${entry.platform} ${entry.case} ${entry.mode}`;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

/** The golden file a cell names, under `root` (the fused-equivalence scenario dir unless a test passes its own). */
export function deferredGoldenPath(entry, root = EQ_DIR) {
	return join(root, entry.mode === "tui" ? "golden-tui" : "golden", entry.platform, `${entry.case}.json`);
}

/** Every problem with the list; empty when each entry is a known cell with an owner, an issue link and a due gate. */
export function validateDeferredList(entries, caseIds) {
	const problems = [];
	const seen = new Set();
	for (const [index, entry] of entries.entries()) {
		const where = `deferred entry #${index} (${cellKey(entry)})`;
		if (!/^[a-z0-9]+-[a-z0-9]+$/.test(entry.platform ?? "")) problems.push(`${where}: platform must be <os>-<arch>`);
		if (!caseIds.includes(entry.case)) problems.push(`${where}: unknown case`);
		if (!MODES.includes(entry.mode)) problems.push(`${where}: mode must be one of ${MODES.join(", ")}`);
		if (!nonEmpty(entry.owner)) problems.push(`${where}: owner is required`);
		if (!ISSUE_URL.test(entry.issue ?? "")) problems.push(`${where}: issue must be a GitHub issue or PR URL`);
		if (!nonEmpty(entry.due)) problems.push(`${where}: due is required`);
		if (seen.has(cellKey(entry))) problems.push(`${where}: duplicate cell`);
		seen.add(cellKey(entry));
	}
	return problems;
}

/** Listed cells whose golden now exists: each one fails the run until its fix PR deletes the entry. */
export function staleDeferredEntries(entries, root = EQ_DIR) {
	return entries.filter((entry) => existsSync(deferredGoldenPath(entry, root)));
}

const deferredLabel = (entry) => `DEFERRED(${entry.owner}, ${entry.issue})`;

/** What a compare run does with one cell: compare its golden, report it DEFERRED, or fail it as missing. */
export function goldenCellVerdict(entries, cell, root = EQ_DIR) {
	if (existsSync(deferredGoldenPath(cell, root))) return { kind: "compare" };
	const entry = entries.find((candidate) => cellKey(candidate) === cellKey(cell));
	return entry ? { kind: "deferred", entry, label: deferredLabel(entry) } : { kind: "missing" };
}

/**
 * The run's summary line and exit code. DEFERRED cells are counted on their own and do not fail the run; a failed
 * case or a stale deferred entry does, and so does a run with nothing selected.
 */
export function summarizeRun(results, staleEntries, mode) {
	const passed = results.filter((r) => r.pass).length;
	const deferred = results.filter((r) => r.deferred).length;
	const failed = results.length - passed - deferred + staleEntries.length;
	return {
		line: `fused-equivalence-qa ${mode}: ${passed}/${results.length} passed, ${deferred} deferred, ${failed} failed`,
		exitCode: failed === 0 && results.length > 0 ? 0 : 1,
	};
}
