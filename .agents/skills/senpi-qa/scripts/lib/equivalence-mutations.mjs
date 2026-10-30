// EQ mutation evidence (plan P0-05d, §6.4 "Mutation evidence"): the pieces of fused-equivalence-mutations-qa.mjs that
// decide something, kept apart from the runs so the unit tests can drive them.
//
// A mutation is a patch to the product source. The driver applies it to a scratch copy of the repo (never the working
// tree), runs the EQ cases the manifest names, and requires each one to FAIL with the expected diff row. A mutation the
// EQ does not catch is a hard failure: the EQ would be blind to that change in behavior.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { goldenCellVerdict } from "./equivalence-deferred.mjs";

const SURFACES = ["rpc", "tui", "desktop"];
const OBSERVATIONS = ["O1", "O2", "O3", "O4", "O5", "O6/O7", "O8 TUI", "O8 desktop"];

/**
 * Row verdicts. KILLED is the only proof; DEFERRED and NO_B0 say why a row has no proof on this platform and never
 * count as one. Every other status fails the run.
 */
export const STATUS = Object.freeze({
	KILLED: "KILLED",
	SURVIVED: "SURVIVED",
	WRONG_FAILURE: "WRONG_FAILURE",
	INCONCLUSIVE: "INCONCLUSIVE",
	STALE: "STALE",
	DIRTY: "DIRTY",
	ERROR: "ERROR",
	DEFERRED: "DEFERRED",
	NO_B0: "NO_B0",
});
const ACCEPTED = new Set([STATUS.KILLED, STATUS.DEFERRED, STATUS.NO_B0]);

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

/** Every problem with the manifest; empty when each row is runnable or explicitly deferred. */
export function validateManifest(mutations, { caseIds, patchDir, tuiCaseIds }) {
	const problems = [];
	const ids = new Set();
	for (const [index, m] of mutations.entries()) {
		const where = `mutation #${index} (${m.id ?? "?"})`;
		if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id ?? "")) problems.push(`${where}: id must be kebab-case`);
		if (ids.has(m.id)) problems.push(`${where}: duplicate id`);
		ids.add(m.id);
		if (!nonEmpty(m.row)) problems.push(`${where}: row (the plan §6.4 mutation row) is required`);
		if (!OBSERVATIONS.includes(m.observation)) problems.push(`${where}: observation must be one of ${OBSERVATIONS}`);
		if (!SURFACES.includes(m.surface)) problems.push(`${where}: surface must be one of ${SURFACES}`);
		if (m.deferred) {
			for (const key of ["owner", "reason", "due"])
				if (!nonEmpty(m.deferred[key])) problems.push(`${where}: deferred.${key} is required`);
			if (m.patch !== undefined) problems.push(`${where}: a deferred row ships no patch here`);
			continue;
		}
		if (!nonEmpty(m.patch) || !existsSync(join(patchDir, m.patch))) problems.push(`${where}: patch file missing`);
		if (!Array.isArray(m.cases) || m.cases.length === 0) problems.push(`${where}: cases are required`);
		for (const id of m.cases ?? []) {
			if (!caseIds.includes(id)) problems.push(`${where}: unknown case ${id}`);
			if (m.surface === "tui" && !tuiCaseIds.includes(id)) problems.push(`${where}: ${id} has no TUI drive`);
			const expect = m.expect?.[id];
			if (!(expect instanceof RegExp)) problems.push(`${where}: expect.${id} must be a RegExp over the diff rows`);
		}
		for (const id of Object.keys(m.expect ?? {}))
			if (!(m.cases ?? []).includes(id)) problems.push(`${where}: expect.${id} names a case the row does not run`);
	}
	return problems;
}

/**
 * What one mutation row runs on this platform. A case whose golden cell is missing is never run: a listed cell is
 * DEFERRED (its owner and issue), and a surface with no goldens on this platform at all is NO_B0. A single missing
 * golden on a recorded surface is a manifest error.
 */
export function planRow(mutation, { platform, deferredGoldens, eqDir }) {
	if (mutation.deferred) return { runnable: [], skipped: [], status: STATUS.DEFERRED, note: deferredNote(mutation) };
	const surfaceDir = join(eqDir, mutation.surface === "tui" ? "golden-tui" : "golden", platform);
	if (!existsSync(surfaceDir))
		return {
			runnable: [],
			skipped: mutation.cases.map((id) => ({ case: id, why: "no-b0" })),
			status: STATUS.NO_B0,
			note: `no ${mutation.surface} goldens recorded for ${platform}`,
		};
	const runnable = [];
	const skipped = [];
	const missing = [];
	for (const id of mutation.cases) {
		const verdict = goldenCellVerdict(deferredGoldens, { platform, case: id, mode: mutation.surface }, eqDir);
		if (verdict.kind === "compare") runnable.push(id);
		else if (verdict.kind === "deferred") skipped.push({ case: id, why: verdict.label });
		else missing.push(id);
	}
	if (missing.length)
		return { runnable: [], skipped, status: STATUS.ERROR, note: `golden missing and not deferred: ${missing}` };
	if (runnable.length === 0)
		return { runnable, skipped, status: STATUS.DEFERRED, note: skipped.map((s) => `${s.case} ${s.why}`).join("; ") };
	return { runnable, skipped, status: undefined, note: "" };
}

const deferredNote = (m) => `DEFERRED(${m.deferred.owner}, due ${m.deferred.due}): ${m.deferred.reason}`;

/** One diff row as the harness prints it, untruncated: the text the expected-message RegExp is matched against. */
const diffRowText = (row) =>
	`${row.path}: golden=${JSON.stringify(row.golden)} actual=${JSON.stringify(row.actual)}`;

/**
 * The verdict for one applied mutation.
 * - `baseline`: the unmutated compare's result per case (must be a PASS, or the row is INCONCLUSIVE).
 * - `run`: the mutated compare: `{ exitCode, results }`, results being the harness receipt's rows.
 * - `revert`: `{ clean, reapplies }` after `git apply -R`.
 */
export function classifyMutation(mutation, { runnable, baseline, run, revert }) {
	const cases = [];
	if (!revert.clean) return { status: STATUS.DIRTY, cases, note: "the scratch tree is not clean after the revert" };
	if (!revert.reapplies) return { status: STATUS.DIRTY, cases, note: "the patch no longer applies after the revert" };
	const unproven = runnable.filter((id) => baseline.get(id) !== "PASS");
	if (unproven.length)
		return {
			status: STATUS.INCONCLUSIVE,
			cases,
			note: `unmutated compare did not PASS: ${unproven.map((id) => `${id}=${baseline.get(id) ?? "not run"}`)}`,
		};
	if (run.exitCode !== 0 && run.exitCode !== 1)
		return { status: STATUS.ERROR, cases, note: `harness exit ${run.exitCode}` };
	for (const id of runnable) {
		const result = run.results.find((r) => r.id === id);
		if (!result) {
			cases.push({ case: id, outcome: "missing", match: null });
			continue;
		}
		if (result.pass) {
			cases.push({ case: id, outcome: "PASS", match: null });
			continue;
		}
		const rows = [...(result.diffs ?? []), ...(result.repeatDiffs ?? [])].map(diffRowText);
		if (result.error) rows.push(`error: ${result.error}`);
		const match = rows.find((row) => mutation.expect[id].test(row)) ?? null;
		cases.push({ case: id, outcome: "FAIL", match, firstRow: rows[0] ?? null, rows: rows.length });
	}
	if (cases.some((c) => c.outcome !== "FAIL"))
		return { status: STATUS.SURVIVED, cases, note: "the EQ passed with the mutation applied: it is blind to it" };
	if (run.exitCode !== 1)
		return { status: STATUS.ERROR, cases, note: `harness exit ${run.exitCode} with failed cases` };
	if (cases.some((c) => !c.match))
		return { status: STATUS.WRONG_FAILURE, cases, note: "FAIL without the expected diff row" };
	return { status: STATUS.KILLED, cases, note: "" };
}

/** The run's exit code: 0 only when every row is KILLED, DEFERRED or NO_B0 and at least one row is KILLED. */
export function runExitCode(rows) {
	const ok = rows.length > 0 && rows.every((r) => ACCEPTED.has(r.status));
	return ok && rows.some((r) => r.status === STATUS.KILLED) ? 0 : 1;
}

const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

/** The markdown table the driver prints and writes to its evidence dir. */
export function renderTable(rows, platform) {
	const lines = [
		`| mutation | observation | surface | cases | expected FAIL message | ${platform} |`,
		"|---|---|---|---|---|---|",
	];
	for (const r of rows) {
		const expected = r.expect
			? Object.entries(r.expect)
					.map(([id, re]) => `${id}: \`${re.source}\``)
					.join("<br>")
			: "";
		const result = [r.status, r.note].filter(Boolean).join(": ");
		lines.push(
			`| ${cell(r.id)} | ${cell(r.observation)} | ${cell(r.surface)} | ${cell((r.cases ?? []).join(","))} | ${cell(expected)} | ${cell(result)} |`,
		);
	}
	return lines.join("\n");
}
