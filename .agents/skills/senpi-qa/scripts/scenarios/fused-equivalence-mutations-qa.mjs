#!/usr/bin/env node
// EQ mutation evidence (plan P0-05d, §6.4 "Mutation evidence"): prove the fused-equivalence EQ is not blind. Every row
// of scenarios/fused-equivalence/mutations/manifest.mjs is a behavioral change to the product; each must make its EQ
// cases FAIL with the expected diff row.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/fused-equivalence-mutations-qa.mjs \
//     [--mutations id,id] [--pipeline legacy] [--scratch-root <dir>] [--keep-scratch] [--evidence <slug>]
//   node .agents/skills/senpi-qa/scripts/scenarios/fused-equivalence-mutations-qa.mjs --self-test
//
// The working tree is never patched. The driver makes one scratch copy of the (clean, committed) tree, runs the
// unmutated compare there first (every case a row relies on must PASS), then per row: apply the patch, run the EQ
// compare for the row's cases, revert, and assert the scratch is clean and the patch still applies. It ends by checking
// that the working tree's HEAD and status did not change, removes the scratch, and prints the table.
//
// Row verdicts (lib/equivalence-mutations.mjs): KILLED is the proof. DEFERRED (a deferred golden cell or a row whose
// owner is another PR) and NO_B0 (no goldens recorded for the surface on this platform) are reported, never counted as
// proof. SURVIVED (the EQ passed with the mutation applied), WRONG_FAILURE, INCONCLUSIVE, STALE, DIRTY and ERROR fail the
// run. Exit 0 only when every row is KILLED, DEFERRED or NO_B0 and at least one row is KILLED.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "../../scenarios/fused-equivalence/cases/index.mjs";
import { goldenPlatform } from "../../scenarios/fused-equivalence/cases/support/host.mjs";
import { deferredGoldens } from "../../scenarios/fused-equivalence/deferred-goldens.mjs";
import { mutations } from "../../scenarios/fused-equivalence/mutations/manifest.mjs";
import { evidenceDir, repoRoot } from "../lib/common.mjs";
import {
	applyPatch,
	headOf,
	makeScratch,
	patchApplies,
	patchSha,
	porcelain,
	revertPatch,
} from "../lib/equivalence-mutation-scratch.mjs";
import {
	classifyMutation,
	planRow,
	renderTable,
	runExitCode,
	STATUS,
	validateManifest,
} from "../lib/equivalence-mutations.mjs";
import { TUI_CASE_IDS } from "../lib/equivalence-tui-cases.mjs";

const EQ_REL = ".agents/skills/senpi-qa/scenarios/fused-equivalence";
const HARNESS_REL = ".agents/skills/senpi-qa/scripts/scenarios/fused-equivalence-qa.mjs";

function parseArgs(argv) {
	const value = (flag) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const selected = value("--mutations")
		?.split(",")
		.map((id) => id.trim());
	const unknown = (selected ?? []).filter((id) => !mutations.some((m) => m.id === id));
	if (unknown.length) throw new Error(`unknown mutation(s): ${unknown.join(", ")}`);
	return {
		selfTest: argv.includes("--self-test"),
		selected,
		pipeline: value("--pipeline") ?? "legacy",
		scratchRoot: value("--scratch-root") ?? process.env.TMPDIR ?? tmpdir(),
		keepScratch: argv.includes("--keep-scratch"),
		evidence: value("--evidence"),
	};
}

/** Run the EQ harness in the scratch copy; the receipt's rows are the result (stdout is kept in the log). */
function runEq(dir, { surface, caseIds, pipeline, slug, log }) {
	const args = [HARNESS_REL, "--compare", "--pipeline", pipeline, "--placement", "fused"];
	args.push("--surface", surface, "--cases", caseIds.join(","), "--evidence", slug);
	return new Promise((resolve, reject) => {
		const out = createWriteStream(log);
		out.write(`$ node ${args.join(" ")}\n`);
		const child = spawn(process.execPath, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		activeChild = child;
		let text = "";
		const take = (chunk) => {
			text += chunk;
			out.write(chunk);
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.on("error", reject);
		child.on("close", (code, signal) => {
			activeChild = undefined;
			out.end();
			for (const line of text.split("\n"))
				if (/^\[(PASS|FAIL|DEFERRED)\]|^fused-equivalence-qa /.test(line)) process.stdout.write(`    ${line}\n`);
			const evidence = /^evidence: (.+)$/m.exec(text)?.[1];
			const receipt =
				evidence && existsSync(join(evidence, "receipt.json")) ? join(evidence, "receipt.json") : undefined;
			const results = receipt ? JSON.parse(readFileSync(receipt, "utf8")).results : [];
			resolve({ exitCode: code ?? (signal ? 128 : 2), results, receipt });
		});
	});
}

let activeChild;
let scratch;
function cleanupOnSignal(signal) {
	activeChild?.kill("SIGTERM");
	scratch?.remove();
	process.stderr.write(`\n${signal}: scratch removed\n`);
	process.exit(130);
}

function selfTest(source) {
	const problems = validateManifest(mutations, {
		caseIds: cases.map((c) => c.id),
		patchDir: join(source, EQ_REL, "mutations"),
		tuiCaseIds: TUI_CASE_IDS,
	});
	for (const m of mutations.filter((row) => row.patch)) {
		if (!patchApplies(source, join(source, EQ_REL, "mutations", m.patch)))
			problems.push(`${m.id}: patch does not apply to HEAD (git apply --check)`);
	}
	process.stdout.write(
		problems.length ? `${problems.join("\n")}\nSELF_TEST_FAIL\n` : `SELF_TEST_OK ${mutations.length} rows\n`,
	);
	return problems.length ? 1 : 0;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const source = repoRoot();
	if (options.selfTest) return selfTest(source);
	const problems = validateManifest(mutations, {
		caseIds: cases.map((c) => c.id),
		patchDir: join(source, EQ_REL, "mutations"),
		tuiCaseIds: TUI_CASE_IDS,
	});
	if (problems.length) throw new Error(`mutations/manifest.mjs is invalid:\n${problems.join("\n")}`);
	const platform = goldenPlatform();
	const selected = mutations.filter((m) => !options.selected || options.selected.includes(m.id));
	const out = evidenceDir(options.evidence ?? `eq-mutations-${platform}`);
	const before = { head: headOf(source), status: porcelain(source) };
	process.on("SIGINT", cleanupOnSignal);
	process.on("SIGTERM", cleanupOnSignal);
	scratch = makeScratch(source, options.scratchRoot);
	process.stdout.write(`scratch ${scratch.dir} at ${scratch.head} (${scratch.copied} ignored entries copied)\n`);
	const rows = [];
	try {
		const eqDir = join(scratch.dir, EQ_REL);
		const plans = selected.map((m) => ({ m, plan: planRow(m, { platform, deferredGoldens, eqDir }) }));
		const baseline = new Map();
		for (const surface of ["rpc", "tui"]) {
			const caseIds = [...new Set(plans.filter((p) => p.m.surface === surface).flatMap((p) => p.plan.runnable))];
			if (!caseIds.length) continue;
			process.stdout.write(`baseline ${surface} ${caseIds.join(",")} (unmutated)\n`);
			const slug = `p05d-baseline-${surface}`;
			const run = await runEq(scratch.dir, { surface, caseIds, ...options, slug, log: join(out, `${slug}.log`) });
			for (const id of caseIds)
				baseline.set(
					`${surface} ${id}`,
					run.results.find((r) => r.id === id)?.pass ? "PASS" : `exit ${run.exitCode}`,
				);
		}
		for (const { m, plan } of plans) {
			const row = { ...m, platform, status: plan.status, note: plan.note, skipped: plan.skipped, results: [] };
			rows.push(row);
			if (plan.status) {
				process.stdout.write(`[${plan.status}] ${m.id}: ${plan.note}\n`);
				continue;
			}
			const patchFile = join(eqDir, "mutations", m.patch);
			row.patchSha256 = patchSha(patchFile);
			const applied = applyPatch(scratch.dir, patchFile);
			if (!applied.applied) {
				Object.assign(row, { status: STATUS.STALE, note: "git apply --check failed at this HEAD" });
				process.stdout.write(`[STALE] ${m.id}\n`);
				continue;
			}
			process.stdout.write(`mutation ${m.id} (${applied.files.join(", ")}) -> ${m.surface} ${plan.runnable}\n`);
			const slug = `p05d-${m.id}`;
			const run = await runEq(scratch.dir, {
				surface: m.surface,
				caseIds: plan.runnable,
				...options,
				slug,
				log: join(out, `${slug}.log`),
			});
			const revert = revertPatch(scratch.dir, patchFile);
			const surfaceBaseline = new Map(plan.runnable.map((id) => [id, baseline.get(`${m.surface} ${id}`)]));
			const verdict = classifyMutation(m, { runnable: plan.runnable, baseline: surfaceBaseline, run, revert });
			Object.assign(row, {
				status: verdict.status,
				note: verdict.note,
				results: verdict.cases,
				exitCode: run.exitCode,
			});
			if (run.receipt) writeFileSync(join(out, `${slug}.receipt.json`), readFileSync(run.receipt));
			process.stdout.write(`[${verdict.status}] ${m.id}${verdict.note ? `: ${verdict.note}` : ""}\n`);
		}
	} finally {
		if (options.keepScratch) process.stdout.write(`scratch kept: ${scratch.root}\n`);
		else scratch.remove();
	}
	const after = { head: headOf(source), status: porcelain(source) };
	const untouched = after.head === before.head && after.status === before.status;
	const table = renderTable(rows, platform);
	const receipt = {
		platform,
		head: scratch.head,
		pipeline: options.pipeline,
		workingTreeUntouched: untouched,
		mutations: rows,
	};
	writeFileSync(
		join(out, "mutations.json"),
		`${JSON.stringify(receipt, (_k, v) => (v instanceof RegExp ? v.source : v), 1)}\n`,
	);
	writeFileSync(join(out, "mutations.md"), `${table}\n`);
	process.stdout.write(`\n${table}\n\nworking tree untouched: ${untouched}\nevidence: ${out}\n`);
	const exitCode = untouched ? runExitCode(rows) : 1;
	const counts = Object.entries(Object.groupBy(rows, (r) => r.status)).map(([s, list]) => `${s}=${list.length}`);
	process.stdout.write(`fused-equivalence-mutations-qa: ${counts.join(" ")} -> exit ${exitCode}\n`);
	return exitCode;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 2;
	});
