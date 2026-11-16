#!/usr/bin/env node
// senpi#6850: release Linux jobs may run on ephemeral Boat self-hosted runners that an external dispatcher starts, but only
// in a workflow_dispatch that names `boat_run_label` while the repository variable RELEASE_BOAT_ENABLED is 'true', and only
// for the jobs listed below. Release/publish security contract: the npm trusted-publishing release job (cloud-hosted
// runners only), the push token and every GitHub Release writer stay on GitHub-hosted runners, and a pull_request event
// never reaches a self-hosted runner. Each job's `runs-on` is evaluated over every trigger, input and variable combination.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { redispatchArgs, watchdogDecision } from "./boat-watchdog.mjs";
import { evaluateExpression, isTruthy } from "./workflow-text.test-support.mjs";

const LABEL = "boat-run-1234-1";
const BOAT_RUNNER = ["self-hosted", "boat-large", LABEL];
const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(
	readdirSync(workflowsDir)
		.filter((file) => file.endsWith(".yml"))
		.map((file) => [file, parse(readFileSync(new URL(file, workflowsDir), "utf8"))]),
);
const nativeTargets = JSON.parse(readFileSync(new URL("./native-prebuild-targets.json", import.meta.url), "utf8"));

// The jobs (native-prebuilds' build by matrix row) allowed on Boat, and what each resolves to without Boat: today's label.
const BOAT_JOBS = {
	"build-binaries.yml build": "ubuntu-latest",
	"native-prebuilds.yml build native-prebuild-linux-arm64": "ubuntu-latest",
	"native-prebuilds.yml build native-prebuild-linux-x64": "ubuntu-latest",
	"publish-npm.yml forced-rest": "ubuntu-latest",
	"publish-npm.yml forced-shard": "ubuntu-latest",
	"publish-npm.yml prepare": "ubuntu-latest",
};
// The jobs each workflow's watchdog must see started (directly or through DONE_JOB's needs) before it stops.
const WATCHED = { "publish-npm.yml": ["prepare", "forced-rest", "forced-shard", "native-prebuilds"], "build-binaries.yml": ["build"] };

function triggers(workflow) {
	const on = workflow.on ?? workflow[true];
	return typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
}

function matrixRows(file, name, job) {
	if (file === "native-prebuilds.yml" && name === "build") return nativeTargets.map((row) => ({ id: ` ${row.artifact}`, matrix: row }));
	const matrix = job.strategy?.matrix;
	if (!matrix || typeof matrix !== "object") return [{ id: "", matrix: {} }];
	return Object.entries(matrix)
		.filter(([, values]) => Array.isArray(values) && values.every((value) => typeof value !== "object"))
		.reduce((rows, [axis, values]) => rows.flatMap((row) => values.map((value) => ({ id: row.id, matrix: { ...row.matrix, [axis]: value } }))), [
			{ id: "", matrix: {} },
		]);
}

function resolve(runsOn, context) {
	if (typeof runsOn !== "string") return runsOn;
	const expression = /^\$\{\{ (.*) \}\}$/.exec(runsOn.trim());
	return expression ? evaluateExpression(expression[1], context) : runsOn;
}

const LABELS = [undefined, "", LABEL];
const VARS = [{}, { RELEASE_BOAT_ENABLED: "false" }, { RELEASE_BOAT_ENABLED: "true" }];

/** Every job/row of every workflow resolved for every event it can start on, every boat_run_label and every variable. */
function resolutions({ events } = {}) {
	const out = [];
	for (const [file, workflow] of Object.entries(workflows)) {
		// A reusable workflow sees its caller's event: publish-npm.yml is dispatched, ci-full-label.yml is a pull request.
		const eventNames = events ?? [...new Set(triggers(workflow).flatMap((event) => (event === "workflow_call" ? ["workflow_dispatch", "pull_request"] : [event])))];
		for (const [name, job] of Object.entries(workflow.jobs)) {
			if (job["runs-on"] === undefined) continue;
			for (const row of matrixRows(file, name, job)) {
				for (const event_name of eventNames) {
					for (const label of LABELS) {
						for (const vars of VARS) {
							const inputs = label === undefined ? {} : { boat_run_label: label };
							const runsOn = resolve(job["runs-on"], { github: { event_name }, inputs, vars, matrix: row.matrix });
							const boat = vars.RELEASE_BOAT_ENABLED === "true" && event_name === "workflow_dispatch" && Boolean(label);
							out.push({ id: `${file} ${name}${row.id}`, file, name, event_name, boat, runsOn, row: row.matrix });
						}
					}
				}
			}
		}
	}
	return out;
}

const selfHosted = (runsOn) => JSON.stringify(runsOn).includes("self-hosted");

describe("release jobs on Boat self-hosted runners (senpi#6850)", () => {
	it("keeps today's runner, byte for byte, for every job unless the variable, a dispatch and boat_run_label all say Boat", () => {
		const all = resolutions();
		assert.ok(all.some((entry) => entry.boat));
		for (const entry of all.filter((candidate) => !candidate.boat)) {
			assert.ok(!selfHosted(entry.runsOn), `${entry.id} reached a self-hosted runner without Boat (${entry.event_name})`);
			if (entry.id in BOAT_JOBS) {
				const today = entry.file === "native-prebuilds.yml" ? entry.row.runner : BOAT_JOBS[entry.id];
				assert.equal(entry.runsOn, today, `${entry.id} changed its hosted runner`);
			}
		}
	});

	it("sends exactly the forced-suite jobs, build-binaries build and the native Linux rows to [self-hosted, boat-large, <label>]", () => {
		const boat = resolutions().filter((entry) => entry.boat);
		const moved = [...new Set(boat.filter((entry) => selfHosted(entry.runsOn)).map((entry) => entry.id))].sort();
		assert.deepEqual(moved, Object.keys(BOAT_JOBS).sort());
		for (const entry of boat.filter((candidate) => candidate.id in BOAT_JOBS)) assert.deepEqual(entry.runsOn, BOAT_RUNNER, entry.id);
		// publish-npm.yml forwards its label to the native Linux rows; run-full-ci passes none.
		assert.equal(workflows["publish-npm.yml"].jobs["native-prebuilds"].with.boat_run_label, "${{ inputs.boat_run_label }}");
		assert.equal(workflows["ci-full-label.yml"].jobs[Object.keys(workflows["ci-full-label.yml"].jobs).find((name) => workflows["ci-full-label.yml"].jobs[name].uses)].with?.boat_run_label, undefined);
		for (const file of ["publish-npm.yml", "build-binaries.yml"]) {
			assert.equal(workflows[file].on.workflow_dispatch.inputs.boat_run_label.default, "", `${file} defaults to GitHub-hosted runners`);
		}
	});

	it("passes the label as one JSON string element, so a label cannot add runner labels", () => {
		const runsOn = workflows["build-binaries.yml"].jobs.build["runs-on"];
		const hostile = 'x","self-hosted';
		const resolved = resolve(runsOn, { github: { event_name: "workflow_dispatch" }, inputs: { boat_run_label: hostile }, vars: { RELEASE_BOAT_ENABLED: "true" } });
		assert.deepEqual(resolved, ["self-hosted", "boat-large", hostile]);
	});

	it("never moves the npm publish/release jobs or any GitHub Release writer", () => {
		const pinned = {
			"publish-npm.yml": ["release", "require-version", "boat-watchdog"],
			"build-binaries.yml": ["smoke-test-binaries", "stage-github-release", "publish-npm", "report-smoke-failure-after-npm", "publish-github-release", "cleanup-draft-github-release", "boat-watchdog"],
		};
		for (const [file, names] of Object.entries(pinned)) {
			for (const name of names) {
				const job = workflows[file].jobs[name];
				assert.ok(job, `${file} has no job ${name}`);
				assert.doesNotMatch(JSON.stringify([job["runs-on"], job.strategy ?? {}]), /boat|self-hosted/i, `${file} ${name}`);
			}
		}
		assert.equal(workflows["publish-npm.yml"].jobs.release["runs-on"], "ubuntu-latest");
	});

	it("never reaches a self-hosted runner on a pull_request event; only native-prebuilds among pull_request workflows names Boat", () => {
		for (const entry of resolutions({ events: ["pull_request", "pull_request_target"] })) {
			assert.ok(!selfHosted(entry.runsOn), `${entry.id} reached a self-hosted runner on ${entry.event_name}`);
		}
		for (const [file, workflow] of Object.entries(workflows)) {
			if (file === "native-prebuilds.yml" || !triggers(workflow).some((event) => event.startsWith("pull_request"))) continue;
			assert.doesNotMatch(readFileSync(new URL(file, workflowsDir), "utf8"), /boat|self-hosted/i, `${file} runs on pull requests and names Boat`);
		}
	});
});

describe("hosted fallback watchdog (senpi#6850)", () => {
	const needsOf = (workflow, name) => [workflow.jobs[name]?.needs ?? []].flat();

	it("runs on GitHub-hosted runners whenever a Boat job can exist, with actions: write and no secret but GITHUB_TOKEN", () => {
		for (const [file, watched] of Object.entries(WATCHED)) {
			const workflow = workflows[file];
			const job = workflow.jobs["boat-watchdog"];
			assert.equal(job["runs-on"], "ubuntu-latest");
			assert.deepEqual(job.permissions, { actions: "write", contents: "read" });
			assert.ok(!JSON.stringify(job).replace("secrets.GITHUB_TOKEN", "").includes("secrets."), `${file} watchdog reads a secret`);
			const step = job.steps.find((candidate) => candidate.run === "node scripts/boat-watchdog.mjs");
			assert.ok(step, `${file} watchdog does not run the script`);
			assert.equal(step.env.WORKFLOW_FILE, file);
			assert.equal(step.env.DISPATCH_INPUTS, "${{ toJSON(inputs) }}");
			// DONE_JOB is a job that starts only after every Boat job, or the Boat job itself.
			const done = step.env.DONE_JOB;
			for (const name of watched) assert.ok(done === name || needsOf(workflow, done).includes(name), `${file}: ${done} does not wait for ${name}`);
			// Whenever any watched job could go to Boat, the watchdog runs.
			const condition = /^\$\{\{ (.*) \}\}$/.exec(job.if)[1];
			for (const vars of VARS) {
				for (const label of LABELS) {
					for (const mode of [{ force_tests: true }, { "publish-only": true }, {}]) {
						const inputs = { ...mode, ...(label === undefined ? {} : { boat_run_label: label }) };
						const boat = vars.RELEASE_BOAT_ENABLED === "true" && Boolean(label);
						const runs = isTruthy(evaluateExpression(condition, { github: { event_name: "workflow_dispatch" }, inputs, vars }));
						if (boat && (file === "build-binaries.yml" || Object.keys(mode).length > 0)) assert.ok(runs, `${file} unguarded for ${JSON.stringify(inputs)}`);
						if (!boat) assert.ok(!runs, `${file} watchdog runs without Boat for ${JSON.stringify(inputs)}`);
					}
				}
				assert.ok(!isTruthy(evaluateExpression(condition, { github: { event_name: "pull_request" }, inputs: { boat_run_label: LABEL, force_tests: true }, vars })));
			}
		}
	});

	const now = Date.parse("2026-11-16T12:00:00Z");
	const job = (name, status, minutesAgo, labels = BOAT_RUNNER) => ({ name, status, labels, created_at: new Date(now - minutesAgo * 60_000).toISOString() });
	const decide = (jobs, doneJob = "release") => watchdogDecision(jobs, { label: LABEL, doneJob, limitSeconds: 600, now });

	it("falls back when a Boat job has waited 10 minutes, and only then", () => {
		assert.deepEqual(decide([job("Forced suite (prepare)", "queued", 10)]), { action: "fallback", stuck: ["Forced suite (prepare)"] });
		assert.deepEqual(decide([job("Forced suite (prepare)", "queued", 9.9)]), { action: "wait" });
		assert.deepEqual(decide([job("Forced suite (prepare)", "in_progress", 30), job("Forced suite (rest)", "queued", 11)]).action, "fallback");
		// A hosted job queued for long is not a Boat problem.
		assert.deepEqual(decide([job("boat-watchdog", "in_progress", 40, ["ubuntu-latest"]), job("other", "queued", 40, ["ubuntu-latest"])]), { action: "wait" });
	});

	it("stops once DONE_JOB has started: a hosted one by existing, a Boat one by leaving the queue", () => {
		assert.equal(decide([job("Forced suite (rest)", "completed", 20), job("release", "queued", 1, ["ubuntu-latest"])]).action, "done");
		assert.equal(decide([job("build", "queued", 2)], "build").action, "wait");
		assert.equal(decide([job("build", "in_progress", 12)], "build").action, "done");
	});

	it("re-dispatches with the same inputs, an empty label, and the run's commit pinned when sha was empty", () => {
		const args = redispatchArgs({
			workflowFile: "publish-npm.yml",
			ref: "main",
			inputs: { version: "", sha: "", dry_run: false, "publish-only": false, force_tests: true, boat_run_label: LABEL },
			pinSha: "a".repeat(40),
		});
		assert.deepEqual(args, ["workflow", "run", "publish-npm.yml", "--ref", "main", "-f", "version=", "-f", `sha=${"a".repeat(40)}`, "-f", "dry_run=false", "-f", "publish-only=false", "-f", "force_tests=true", "-f", "boat_run_label="]);
		const binaries = redispatchArgs({ workflowFile: "build-binaries.yml", ref: "main", inputs: { tag: "v1", source_ref: "", dry_run: true, boat_run_label: LABEL }, pinSha: "" });
		assert.deepEqual(binaries.slice(5), ["-f", "tag=v1", "-f", "source_ref=", "-f", "dry_run=true", "-f", "boat_run_label="]);
	});

	it("dispatches the hosted run before cancelling this one, through gh", () => {
		const dir = mkdtempSync(join(tmpdir(), "boat-watchdog-"));
		const log = join(dir, "calls.log");
		const fakeGh = join(dir, "gh");
		const jobs = { jobs: [job("Forced suite (prepare)", "queued", 15)].map((entry) => ({ ...entry, created_at: new Date(Date.now() - 15 * 60_000).toISOString() })) };
		writeFileSync(
			fakeGh,
			`#!/usr/bin/env node\nconst fs=require("fs");fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+"\\n");\nif(process.argv[2]==="api") process.stdout.write(JSON.stringify([${JSON.stringify(jobs)}]));\n`,
		);
		chmodSync(fakeGh, 0o755);
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("./boat-watchdog.mjs", import.meta.url))], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				GH_BIN: fakeGh,
				GH_REPO: "owner/repo",
				RUN_ID: "77",
				RUN_ATTEMPT: "2",
				BOAT_RUN_LABEL: LABEL,
				DONE_JOB: "release",
				WORKFLOW_FILE: "publish-npm.yml",
				DISPATCH_REF: "main",
				DISPATCH_INPUTS: JSON.stringify({ version: "", sha: "", force_tests: true, boat_run_label: LABEL }),
				PIN_SHA: "b".repeat(40),
			},
		});
		assert.equal(result.status, 1, result.stderr);
		const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(calls[0], ["api", "--paginate", "--slurp", "repos/owner/repo/actions/runs/77/attempts/2/jobs"]);
		assert.deepEqual(calls[1].slice(0, 5), ["workflow", "run", "publish-npm.yml", "--ref", "main"]);
		assert.ok(calls[1].includes("boat_run_label=") && calls[1].includes(`sha=${"b".repeat(40)}`));
		assert.deepEqual(calls[2], ["run", "cancel", "77", "--repo", "owner/repo"]);
		assert.equal(calls.length, 3);
	});
});
