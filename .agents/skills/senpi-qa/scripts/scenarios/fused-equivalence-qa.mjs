#!/usr/bin/env node
// EQ harness (plan P0-05b, §6.2-§6.4): drive the real CLI through each fused-equivalence case, collect O1-O8,
// normalize, and compare against the B0 goldens (`--compare`) or write them (`--record`). The pipeline witness is read
// separately and asserted on its own; it is never part of the equality.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/fused-equivalence-qa.mjs --compare --pipeline legacy \
//     --placement fused [--cases E01,E02] [--surface rpc] [--repeat N] [--child node|binary:<path>] --evidence <slug>
//
// The CLI child runs on Bun unless `--child` says otherwise (lib/common.mjs). Exit code 0 only when every selected
// case matches its golden on every declared observable and its witness matches `--pipeline`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cases } from "../../scenarios/fused-equivalence/cases/index.mjs";
import { startCaseRun } from "../../scenarios/fused-equivalence/cases/support/case-run.mjs";
import { baselineManifest, goldenDir, observe } from "../../scenarios/fused-equivalence/cases/support/observe.mjs";
import { ownTsxCache } from "../../scenarios/fused-equivalence/cases/support/tsx-cache.mjs";
import { expectedWitness, readWitness } from "../../scenarios/fused-equivalence/cases/support/witness.mjs";
import { childRuntime, evidenceDir, guardRealAuth, installCleanupHooks, repoRoot } from "../lib/common.mjs";
import { diffNormalized } from "../lib/equivalence-normalize.mjs";

/** Placements and surfaces whose producers come later in the plan; asking for them is an error, never a PASS. */
const DEFERRED = {
	placement: { "split-local": "S27a", "split-remote": "DM1", hosted: "V4" },
	surface: { tui: "P0-05c", desktop: "P0-07b" },
};

function parseArgs(argv) {
	const value = (flag) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const mode = argv.includes("--record") ? "record" : argv.includes("--compare") ? "compare" : undefined;
	if (!mode) throw new Error("pass --compare or --record");
	const placement = value("--placement") ?? "fused";
	const surface = value("--surface") ?? "rpc";
	for (const [kind, requested] of [
		["placement", placement],
		["surface", surface],
	]) {
		const owner = DEFERRED[kind][requested];
		if (owner) throw new Error(`--${kind} ${requested} is DEFERRED(${owner}): its producer has not landed`);
	}
	if (placement !== "fused") throw new Error(`unknown --placement ${placement}`);
	if (surface !== "rpc" && surface !== "headless") throw new Error(`unknown --surface ${surface}`);
	const pipeline = value("--pipeline") ?? "default";
	expectedWitness(pipeline);
	const selected = value("--cases")
		?.split(",")
		.map((id) => id.trim().toUpperCase());
	const unknown = (selected ?? []).filter((id) => !cases.some((c) => c.id === id));
	if (unknown.length) throw new Error(`unknown case(s): ${unknown.join(", ")}`);
	const repeat = Number.parseInt(value("--repeat") ?? "1", 10);
	if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
	return { mode, placement, surface, pipeline, selected, repeat, evidence: value("--evidence") };
}

async function runCase(testCase, { pipeline, surface }) {
	const env = pipeline === "default" ? {} : { SENPI_EXECUTION_PIPELINE: pipeline };
	const spec = typeof testCase.spec === "function" ? testCase.spec() : testCase.spec;
	const run = await startCaseRun({ ...spec, label: testCase.id.toLowerCase(), env: { ...spec.env, ...env } });
	try {
		await testCase.drive(run);
		const observables =
			surface === "headless"
				? testCase.observables.filter((id) => id === "O7" || id === "O8")
				: testCase.observables;
		return { observations: observe(run, observables), witness: readWitness(run.sessionFile) };
	} finally {
		await run.stop();
		run.box.cleanup();
	}
}

function summarizeDiffs(diffs) {
	return diffs
		.slice(0, 12)
		.map(
			(row) =>
				`    ${row.path}: golden=${JSON.stringify(row.golden)?.slice(0, 160)} actual=${JSON.stringify(row.actual)?.slice(0, 160)}`,
		);
}

async function main() {
	installCleanupHooks();
	const options = parseArgs(process.argv.slice(2));
	const guard = guardRealAuth();
	const selected = cases.filter((c) => !options.selected || options.selected.includes(c.id));
	const dir = goldenDir();
	const command = `node .agents/skills/senpi-qa/scripts/scenarios/fused-equivalence-qa.mjs ${process.argv.slice(2).join(" ")}`;
	// Read before any golden is written: the manifest names the tree the goldens were recorded from, so a record run's own
	// output must not mark that tree dirty.
	const manifest = baselineManifest({ repo: repoRoot(), childRuntime: childRuntime().label, command });
	const results = [];
	for (const testCase of selected) {
		const runs = [];
		let error;
		try {
			for (let index = 0; index < options.repeat; index++) runs.push(await runCase(testCase, options));
		} catch (caught) {
			error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
		}
		const goldenPath = join(dir, `${testCase.id}.json`);
		const result = {
			id: testCase.id,
			title: testCase.title,
			observables: testCase.observables,
			error,
			runs: runs.length,
		};
		if (!error) {
			const first = runs[0].observations;
			result.repeatDiffs = runs.slice(1).flatMap((other) => diffNormalized(first, other.observations));
			result.witness = runs[0].witness;
			result.witnessOk = runs.every((r) => r.witness.pipeline === expectedWitness(options.pipeline));
			if (options.mode === "record") {
				// A golden is written only from runs that agreed with each other: a nondeterministic case is a FAIL, never a golden.
				if (result.repeatDiffs.length === 0) {
					mkdirSync(dir, { recursive: true });
					writeFileSync(
						goldenPath,
						`${JSON.stringify({ id: testCase.id, title: testCase.title, observations: first }, null, 1)}\n`,
					);
				}
				result.diffs = [];
			} else {
				const golden = existsSync(goldenPath)
					? JSON.parse(readFileSync(goldenPath, "utf8")).observations
					: undefined;
				result.diffs = golden
					? diffNormalized(golden, first)
					: [{ path: "$", golden: "<missing golden>", actual: "<observed>" }];
			}
			result.observed = first;
		}
		result.pass = !error && result.witnessOk && result.repeatDiffs.length === 0 && result.diffs.length === 0;
		process.stdout.write(
			`[${result.pass ? "PASS" : "FAIL"}] ${testCase.id} ${testCase.title}${error ? ` - ${error.split("\n")[0]}` : ""}\n`,
		);
		for (const line of summarizeDiffs([...(result.diffs ?? []), ...(result.repeatDiffs ?? [])]))
			process.stdout.write(`${line}\n`);
		if (result.witnessOk === false)
			process.stdout.write(
				`    witness.pipeline=${result.witness.pipeline} expected=${expectedWitness(options.pipeline)}\n`,
			);
		results.push(result);
	}
	guard.assertUnchanged();
	if (options.mode === "record") writeFileSync(join(dir, "baseline.json"), `${JSON.stringify(manifest, null, 1)}\n`);
	const passed = results.filter((r) => r.pass).length;
	process.stdout.write(
		`\nfused-equivalence-qa ${options.mode}: ${passed}/${results.length} passed (child_runtime=${manifest.runtimes.child})\n`,
	);
	if (options.evidence) {
		const out = evidenceDir(options.evidence);
		const receipt = {
			command,
			child_runtime: manifest.runtimes.child,
			manifest,
			options,
			results: results.map(({ observed, ...rest }) => rest),
		};
		writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 1)}\n`);
		for (const r of results)
			if (r.observed) writeFileSync(join(out, `${r.id}.observed.json`), `${JSON.stringify(r.observed, null, 1)}\n`);
		process.stdout.write(`evidence: ${out}\n`);
	}
	process.exitCode = passed === results.length && results.length > 0 ? 0 : 1;
}

const releaseTsxCache = ownTsxCache();
main()
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 2;
	})
	.finally(releaseTsxCache);
