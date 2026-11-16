#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { PLATFORM_WORKFLOWS } from "./ci-platform-red.mjs";
import { classify, FULL_CI_LABEL, PLATFORM_JOBS, verifyNeeds } from "./ci-platform-scope.mjs";

const workflowDir = new URL("../.github/workflows/", import.meta.url);
const workflow = (file) => parse(readFileSync(new URL(file, workflowDir), "utf8"));
const script = fileURLToPath(new URL("./ci-platform-scope.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const FULL_IF = "needs.platform-scope.outputs.full == 'true'";
const CLASSIFY = "ci-platform-scope.mjs classify";
const LINUX_MATRIX = (job) => Array.isArray(job.strategy?.matrix?.os) && job.strategy.matrix.os.every((label) => /^ubuntu-/.test(label));

// Runs a workflow's own classify step (its run text and env expressions) the way the runner would, for one event.
function decide(file, jobName, { event, labels }) {
	const step = workflow(file).jobs[jobName].steps.find((candidate) => candidate.run?.includes(CLASSIFY));
	assert.ok(step, `${file}: ${jobName} has no classify step`);
	const dir = mkdtempSync(join(tmpdir(), "ci-platform-scope-"));
	try {
		const output = join(dir, "output");
		writeFileSync(output, "");
		const env = { ...process.env, GITHUB_OUTPUT: output, EVENT_NAME: event, PR_LABELS: JSON.stringify(event === "pull_request" ? labels : null) };
		for (const [name, value] of Object.entries(step.env ?? {})) {
			if (!["EVENT_NAME", "PR_LABELS"].includes(name)) env[name] = String(value);
		}
		const run = spawnSync("bash", ["-c", step.run], { cwd: repoRoot, encoding: "utf8", env });
		assert.equal(run.status, 0, `${file}: ${run.stderr}`);
		return readFileSync(output, "utf8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("platform scope classifier (senpi#6834)", () => {
	it("keeps every unlabelled pull request on Linux, whatever its diff", () => {
		assert.deepEqual(classify({ event: "pull_request", labels: [] }).full, false);
		assert.deepEqual(classify({ event: "pull_request", labels: ["bug", "needs-review"] }).full, false);
		// A merge queue run carries no labels; none of these workflows uses one today.
		assert.deepEqual(classify({ event: "merge_group", labels: [] }).full, false);
	});

	it("runs the full set for the run-full-ci label and for every event that is not a pull request", () => {
		assert.equal(classify({ event: "pull_request", labels: ["bug", FULL_CI_LABEL] }).full, true);
		for (const event of ["push", "workflow_dispatch", "schedule"]) {
			assert.equal(classify({ event, labels: [] }).full, true, event);
		}
	});

	it("writes the decision to GITHUB_OUTPUT from the CLI", () => {
		const dir = mkdtempSync(join(tmpdir(), "ci-platform-scope-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			const run = (event, labels) => spawnSync(process.execPath, [script, "classify", "--event", event, "--labels", labels],
				{ encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
			for (const [event, labels] of [["pull_request", "[]"], ["pull_request", JSON.stringify([FULL_CI_LABEL])], ["push", "null"]]) {
				const result = run(event, labels);
				assert.equal(result.status, 0, result.stderr);
			}
			assert.equal(readFileSync(output, "utf8"), "full=false\nfull=true\nfull=true\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pull request runners across every workflow (senpi#6834)", () => {
	const PR_EVENTS = ["pull_request", "pull_request_target", "merge_group"];
	const files = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
	const triggers = (on) => typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
	const prTriggered = files.filter((file) => triggers(workflow(file).on).some((event) => PR_EVENTS.includes(event)));
	// A workflow a PR-triggered workflow calls runs with that pull request's event too.
	const called = prTriggered.flatMap((file) => Object.values(workflow(file).jobs).flatMap((job) =>
		job.uses?.startsWith("./.github/workflows/") ? [job.uses.slice("./.github/workflows/".length)] : []));
	const reachable = [...new Set([...prTriggered, ...called])].sort();
	const LINUX = /^ubuntu-/;

	it("PLATFORM_WORKFLOWS names exactly the pull request workflows that can reach a macOS/Windows runner", () => {
		const platform = reachable.filter((file) => Object.values(workflow(file).jobs).some((job) => !job.uses && !/^ubuntu-/.test(String(job["runs-on"])) && !LINUX_MATRIX(job)));
		assert.deepEqual(platform, Object.keys(PLATFORM_WORKFLOWS).sort());
		for (const [file, name] of Object.entries(PLATFORM_WORKFLOWS)) assert.equal(workflow(file).name, name, file);
	});

	for (const file of reachable) {
		it(`${file} schedules macOS/Windows on a pull request only through the platform scope`, () => {
			const { jobs } = workflow(file);
			for (const [name, job] of Object.entries(jobs)) {
				if (job.uses) continue;
				const runsOn = String(job["runs-on"]);
				if (LINUX.test(runsOn)) continue;
				const where = `${file}: ${name} (runs-on ${runsOn})`;
				if (/macos|windows/.test(runsOn)) {
					assert.equal(job.if, FULL_IF, where);
					assert.ok([job.needs].flat().includes("platform-scope"), where);
				} else if (runsOn === "${{ matrix.os }}") {
					const os = job.strategy.matrix.os;
					if (Array.isArray(os)) assert.ok(os.every((label) => LINUX.test(label)), where);
					else {
						assert.match(os, /^\$\{\{ fromJSON\(needs\.platform-scope\.outputs\.full == 'true' && '\[.*\]' \|\| '\["ubuntu-latest"\]'\) \}\}$/, where);
						assert.ok([job.needs].flat().includes("platform-scope"), where);
					}
				} else if (runsOn === "${{ matrix.runner }}") {
					// The matrix comes from a planning job, which must narrow it by the scope decision.
					const planner = String(job.strategy.matrix).match(/needs\.([\w-]+)\.outputs\./)?.[1];
					assert.ok(planner, where);
					const steps = jobs[planner].steps;
					const scope = steps.find((step) => step.run?.includes(CLASSIFY));
					assert.ok(scope?.id, `${where}: ${planner} classifies`);
					assert.ok(steps.some((step) => String(step.env?.FULL).includes(`steps.${scope.id}.outputs.full`)), `${where}: ${planner} passes the decision on`);
				} else {
					assert.fail(`${where}: unrecognised runner`);
				}
			}
		});
	}

	it("decides from the run-full-ci label alone in every workflow that classifies", () => {
		const scoped = [["ci.yml", "platform-scope"], ["read-summary-binary-parity.yml", "platform-scope"], ["session-worker-compile.yml", "platform-scope"], ["native-prebuilds.yml", "plan"]];
		for (const [file, job] of scoped) {
			assert.equal(decide(file, job, { event: "pull_request", labels: ["bug"] }), "full=false\n", file);
			assert.equal(decide(file, job, { event: "pull_request", labels: [FULL_CI_LABEL] }), "full=true\n", file);
			assert.ok(!workflow(file).jobs[job].steps.some((step) => /pulls\/.*\/files/.test(step.run ?? "")), `${file} reads no diff`);
		}
		for (const [file, job] of scoped.slice(0, 3)) assert.equal(decide(file, job, { event: "push", labels: [] }), "full=true\n", file);
	});
});

describe("Check and test fan-in", () => {
	const needs = (override) => Object.fromEntries(
		["check", "platform-scope", ...PLATFORM_JOBS].map((name) => [name, { result: override[name] ?? "success" }]));

	it("accepts skipped platform jobs only when the run was decided not full", () => {
		const skipped = Object.fromEntries(PLATFORM_JOBS.map((name) => [name, "skipped"]));
		assert.deepEqual(verifyNeeds(needs(skipped), "false"), []);
		assert.equal(verifyNeeds(needs(skipped), "true").length, PLATFORM_JOBS.length);
		// platform-scope failed: no output, so nothing may be skipped.
		assert.equal(verifyNeeds(needs({ ...skipped, "platform-scope": "failure" }), "").length, PLATFORM_JOBS.length + 1);
	});

	it("rejects a skipped non-platform job and any failed or cancelled job", () => {
		assert.deepEqual(verifyNeeds(needs({ check: "skipped" }), "false"), ["check finished with result 'skipped'"]);
		for (const result of ["failure", "cancelled"]) {
			assert.equal(verifyNeeds(needs({ "macos-combined": result }), "false").length, 1, result);
		}
	});

	it("exits non-zero from the CLI when a job failed", () => {
		const run = (override) => spawnSync(process.execPath, [script, "verify", "--full", "false"],
			{ encoding: "utf8", env: { ...process.env, NEEDS_JSON: JSON.stringify(needs(override)) } });
		assert.equal(run({ "macos-combined": "skipped" }).status, 0);
		assert.equal(run({ "macos-combined": "failure" }).status, 1);
	});
});

describe("ci.yml wiring", () => {
	const { jobs, on } = workflow("ci.yml");

	it("gates exactly the macOS/Windows-only jobs on the platform scope", () => {
		const platformOnly = Object.keys(jobs).filter((name) => /macos|windows/.test(String(jobs[name]["runs-on"])));
		assert.deepEqual(platformOnly.sort(), [...PLATFORM_JOBS].sort());
		for (const [name, job] of Object.entries(jobs)) {
			if (!PLATFORM_JOBS.includes(name)) assert.notEqual(job.if, FULL_IF, name);
		}
	});

	it("feeds every gated job and the scope itself into the fan-in through the verifier", () => {
		const fanIn = jobs["check-and-test"];
		for (const name of ["platform-scope", ...PLATFORM_JOBS]) assert.ok(fanIn.needs.includes(name), name);
		const verify = fanIn.steps.find((step) => step.run?.includes("ci-platform-scope.mjs verify"));
		assert.ok(verify);
		assert.equal(verify.env.NEEDS_JSON, "${{ toJSON(needs) }}");
		assert.match(verify.run, /--full "\$\{\{ needs\.platform-scope\.outputs\.full \}\}"/);
	});

	it("still runs on main pushes and through the label workflow", () => {
		assert.deepEqual(on.push, { branches: ["main"] });
		assert.ok("workflow_call" in on);
	});
});

describe("run-full-ci label workflow", () => {
	const label = workflow("ci-full-label.yml");

	it("runs every workflow with macOS/Windows legs in full when the label is added and on every later push of the labelled PR (senpi#4968, senpi#6834)", () => {
		assert.deepEqual(label.on.pull_request.types, ["labeled", "opened", "synchronize", "reopened"]);
		const callers = Object.values(label.jobs);
		assert.deepEqual(callers.map((job) => job.uses.replace("./.github/workflows/", "")).sort(), Object.keys(PLATFORM_WORKFLOWS).sort());
		for (const job of callers) {
			assert.equal(
				job.if,
				`contains(github.event.pull_request.labels.*.name, '${FULL_CI_LABEL}') && (github.event.action != 'labeled' || github.event.label.name == '${FULL_CI_LABEL}')`,
			);
		}
	});
});

describe("workflows with macOS/Windows legs", () => {
	it("each of them runs its full set on every push to main", () => {
		for (const file of Object.keys(PLATFORM_WORKFLOWS)) assert.deepEqual(workflow(file).on.push.branches, ["main"], file);
	});

	describe("concurrency", () => {
		// Evaluates the concurrency expressions these workflows use, for one run context.
		const evaluate = (value, run) => typeof value === "boolean" ? value : String(value).replace(/\$\{\{(.*?)\}\}/g, (_, expr) => {
			const js = expr
				.replace(/github\.event_name/g, "run.event").replace(/github\.workflow/g, "run.workflow")
				.replace(/github\.event\.pull_request\.number/g, "run.pr").replace(/github\.ref/g, "run.ref").replace(/github\.sha/g, "run.sha")
				.replace(/==/g, "===");
			assert.doesNotMatch(js, /github\./, `unsupported expression: ${expr}`);
			return String(Function("run", `return (${js});`)(run));
		});
		const files = Object.keys(PLATFORM_WORKFLOWS);
		const pr = (workflowName, sha = "s1") => ({ event: "pull_request", workflow: workflowName, ref: "refs/pull/7/merge", pr: 7, sha });
		const push = (workflowName, sha) => ({ event: "push", workflow: workflowName, ref: "refs/heads/main", pr: undefined, sha });
		const LABEL = workflow("ci-full-label.yml").name;

		it("never shares a group between sibling workflows of one label run", () => {
			const groups = files.map((file) => evaluate(workflow(file).concurrency.group, pr(LABEL)));
			assert.equal(new Set(groups).size, files.length, groups.join(" | "));
		});

		it("never shares a group between a label run and the PR's own run", () => {
			for (const file of files) {
				const { group } = workflow(file).concurrency;
				assert.notEqual(evaluate(group, pr(LABEL)), evaluate(group, pr(PLATFORM_WORKFLOWS[file])), file);
			}
		});

		it("cancels a superseded PR run but gives every main commit its own uncancelled group", () => {
			for (const file of files) {
				const { group, "cancel-in-progress": cancel } = workflow(file).concurrency;
				assert.equal(evaluate(group, pr("W", "a")), evaluate(group, pr("W", "b")), file);
				assert.equal(evaluate(cancel, pr("W")), "true", file);
				assert.notEqual(evaluate(group, push("W", "c1")), evaluate(group, push("W", "c2")), file);
				assert.equal(evaluate(cancel, push("W", "c1")), "false", file);
			}
		});
	});
});
