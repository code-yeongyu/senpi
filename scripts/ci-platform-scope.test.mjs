#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { classify, FULL_CI_LABEL, isPlatformPath, PLATFORM_JOBS, platformJobFiles, verifyNeeds } from "./ci-platform-scope.mjs";

const workflow = (file) => parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
const script = fileURLToPath(new URL("./ci-platform-scope.mjs", import.meta.url));
const pr = (changedPaths, labels = []) => classify({ event: "pull_request", labels, changedPaths });
const runsOn = (job) => JSON.stringify([job["runs-on"], job.strategy?.matrix?.os ?? null]);
const FULL_IF = "needs.platform-scope.outputs.full == 'true'";

describe("platform scope classifier (senpi#3957)", () => {
	it("keeps general source changes off macOS and Windows", () => {
		for (const path of [
			"packages/coding-agent/src/core/agent-session.ts",
			"packages/coding-agent/test/suite/hooks-trust.test.ts",
			"packages/ai/src/providers/openai.ts",
			"packages/tui/src/editor.ts",
			"README.md",
			"packages/coding-agent/package.json",
		]) {
			assert.equal(isPlatformPath(path), false, path);
		}
		assert.deepEqual(pr(["packages/coding-agent/src/core/agent-session.ts", "CHANGELOG.md"]).full, false);
	});

	it("runs the full set for platform-specific paths", () => {
		for (const path of [
			".github/workflows/ci.yml",
			"scripts/ci-platform-scope.mjs",
			"scripts/run-tests.mjs",
			"crates/senpi-pty/src/lib.rs",
			"Cargo.lock",
			"packages/pty/src/index.ts",
			"packages/coding-agent/native/index.js",
			"package-lock.json",
			"bun.lock",
			"scripts/build-binaries.sh",
			"scripts/prepare-bun-compile-assets.mjs",
			"scripts/qa/read-summary-build.mjs",
			"packages/coding-agent/src/modes/rpc/tool-child/windows-job.win32.test.ts",
			"packages/coding-agent/src/utils/darwin/keychain.ts",
			"packages/coding-agent/src/core/shell-macos.ts",
			"scripts/devenv-setup.ps1",
		]) {
			assert.equal(isPlatformPath(path), true, path);
		}
		assert.equal(pr(["packages/ai/src/x.ts", "crates/senpi-grep/src/lib.rs"]).full, true);
	});

	it("counts the RPC sources and every file a macOS/Windows job runs as platform-specific", () => {
		const text = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
		const jobFiles = platformJobFiles(text);
		for (const path of [
			"packages/coding-agent/src/modes/rpc/socket-transport.ts",
			"packages/coding-agent/src/modes/rpc/host-readiness.ts",
		]) {
			assert.equal(isPlatformPath(path), true, path);
		}
		for (const path of [
			"packages/coding-agent/test/suite/hooks-trust.test.ts",
			"packages/coding-agent/test/suite/schedule-runner.test.ts",
			"packages/coding-agent/test/rpc-socket-transport.test.ts",
			"packages/tui/test/tui-main-screen-mouse.test.ts",
			"packages/senpi-codemode/test/js-kernel-webview.test.ts",
		]) {
			assert.equal(isPlatformPath(path, jobFiles), true, path);
		}
		// A suite only the Linux jobs run stays off macOS/Windows.
		assert.equal(isPlatformPath("packages/coding-agent/test/suite/agent-session-compaction.test.ts", jobFiles), false);
		assert.equal(pr(["packages/coding-agent/test/suite/hooks-trust.test.ts"]).full, false);
		assert.equal(classify({ event: "pull_request", labels: [], changedPaths: ["packages/coding-agent/test/suite/hooks-trust.test.ts"], jobFiles }).full, true);
		// Only jobs on a macOS/Windows runner contribute: the Linux-only check job's own files do not.
		assert.ok(!jobFiles.includes("packages/senpi-codemode/scripts/gate-build.ts"));
	});

	it("runs the full set for every non-PR event, the label, and an unknown or truncated diff", () => {
		for (const event of ["push", "merge_group", "workflow_dispatch", "schedule"]) {
			assert.equal(classify({ event, labels: [], changedPaths: ["README.md"] }).full, true, event);
		}
		assert.equal(pr(["README.md"], ["bug", FULL_CI_LABEL]).full, true);
		assert.equal(pr(null).full, true);
		assert.equal(pr([]).full, true);
		assert.equal(pr(Array.from({ length: 3000 }, (_, i) => `docs/${i}.md`)).full, true);
	});

	it("writes the decision to GITHUB_OUTPUT from the CLI", () => {
		const dir = mkdtempSync(join(tmpdir(), "ci-platform-scope-"));
		try {
			const changed = join(dir, "changed");
			const output = join(dir, "output");
			writeFileSync(changed, "packages/ai/src/x.ts\n");
			writeFileSync(output, "");
			const run = (labels, file) => spawnSync(process.execPath,
				[script, "classify", "--event", "pull_request", "--labels", labels, "--changed", file],
				{ encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
			assert.equal(run("[]", changed).status, 0);
			assert.equal(run(JSON.stringify([FULL_CI_LABEL]), changed).status, 0);
			assert.equal(run("[]", "").status, 0);
			writeFileSync(changed, "packages/coding-agent/test/suite/hooks-trust.test.ts\n");
			assert.equal(run("[]", changed).status, 0);
			const withWorkflow = spawnSync(process.execPath,
				[script, "classify", "--event", "pull_request", "--labels", "null", "--changed", changed, "--workflow", fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url))],
				{ encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
			assert.equal(withWorkflow.status, 0, withWorkflow.stderr);
			assert.equal(readFileSync(output, "utf8"), "full=false\nfull=true\nfull=true\nfull=false\nfull=true\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
		for (const name of PLATFORM_JOBS) {
			assert.ok([jobs[name].needs].flat().includes("platform-scope"), name);
			assert.equal(jobs[name].if, FULL_IF, name);
		}
		for (const [name, job] of Object.entries(jobs)) {
			if (!PLATFORM_JOBS.includes(name)) assert.notEqual(job.if, FULL_IF, name);
		}
	});

	it("keeps Windows matrix legs only for a full run", () => {
		for (const [name, job] of Object.entries(jobs)) {
			if (!/windows/.test(runsOn(job)) && !/fromJSON/.test(runsOn(job))) continue;
			if (PLATFORM_JOBS.includes(name)) continue;
			assert.match(String(job.strategy.matrix.os), /needs\.platform-scope\.outputs\.full == 'true'/, name);
			assert.ok([job.needs].flat().includes("platform-scope"), name);
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

	it("classifies from the PR file list and the labels, and still runs on main pushes", () => {
		assert.deepEqual(on.push, { branches: ["main"] });
		assert.ok("workflow_call" in on);
		const classifyStep = jobs["platform-scope"].steps.find((step) => step.run?.includes("ci-platform-scope.mjs classify"));
		assert.ok(classifyStep);
		assert.match(classifyStep.env.PR_LABELS, /github\.event\.pull_request\.labels\.\*\.name/);
		assert.match(classifyStep.run, /--workflow \.github\/workflows\/ci\.yml$/);
		assert.equal(jobs["platform-scope"]["runs-on"], "ubuntu-latest");
	});
});

describe("run-full-ci label workflow", () => {
	const label = workflow("ci-full-label.yml");

	it("runs the CI and platform workflows in full when the label is added and on every later push of the labelled PR (senpi#4968)", () => {
		assert.deepEqual(label.on.pull_request.types, ["labeled", "opened", "synchronize", "reopened"]);
		const callers = Object.values(label.jobs);
		assert.deepEqual(callers.map((job) => job.uses).sort(), [
			"./.github/workflows/ci.yml",
			"./.github/workflows/read-summary-binary-parity.yml",
			"./.github/workflows/session-worker-compile.yml",
		]);
		for (const job of callers) {
			assert.equal(
				job.if,
				`contains(github.event.pull_request.labels.*.name, '${FULL_CI_LABEL}') && (github.event.action != 'labeled' || github.event.label.name == '${FULL_CI_LABEL}')`,
			);
		}
	});
});

describe("platform-only legs of the other PR workflows", () => {
	for (const file of ["read-summary-binary-parity.yml", "session-worker-compile.yml"]) {
		it(`${file} runs macOS/Windows on PRs only when the scope is full, and in full on main`, () => {
			const { on, jobs } = workflow(file);
			assert.deepEqual(on.push.branches, ["main"]);
			assert.deepEqual(on.push.paths, on.pull_request.paths);
			assert.ok("workflow_call" in on);
			const legs = Object.values(jobs).filter((job) => job.strategy?.matrix?.os);
			assert.equal(legs.length, 1);
			assert.match(String(legs[0].strategy.matrix.os), /needs\.platform-scope\.outputs\.full == 'true'/);
			const scope = jobs["platform-scope"];
			assert.ok(scope.steps[0].with["sparse-checkout"].split("\n").includes(`.github/workflows/${file}`));
			assert.ok(scope.steps.some((step) => step.run?.endsWith(`--workflow .github/workflows/${file}`)));
		});
	}

	describe("concurrency of the workflows the label calls", () => {
		// Evaluates the concurrency expressions these workflows use, for one run context.
		const evaluate = (value, run) => typeof value === "boolean" ? value : String(value).replace(/\$\{\{(.*?)\}\}/g, (_, expr) => {
			const js = expr
				.replace(/github\.event_name/g, "run.event").replace(/github\.workflow/g, "run.workflow")
				.replace(/github\.event\.pull_request\.number/g, "run.pr").replace(/github\.ref/g, "run.ref").replace(/github\.sha/g, "run.sha")
				.replace(/==/g, "===");
			assert.doesNotMatch(js, /github\./, `unsupported expression: ${expr}`);
			return String(Function("run", `return (${js});`)(run));
		});
		const files = ["ci.yml", "read-summary-binary-parity.yml", "session-worker-compile.yml"];
		const pr = (workflowName, sha = "s1") => ({ event: "pull_request", workflow: workflowName, ref: "refs/pull/7/merge", pr: 7, sha });
		const push = (workflowName, sha) => ({ event: "push", workflow: workflowName, ref: "refs/heads/main", pr: undefined, sha });
		const LABEL = "CI full set (run-full-ci label)";

		it("never shares a group between sibling workflows of one label run", () => {
			const groups = files.map((file) => evaluate(workflow(file).concurrency.group, pr(LABEL)));
			assert.equal(new Set(groups).size, files.length, groups.join(" | "));
		});

		it("never shares a group between a label run and the PR's own run", () => {
			const own = { "ci.yml": "CI", "read-summary-binary-parity.yml": "Read summary binary parity", "session-worker-compile.yml": "Compiled session worker" };
			for (const file of files) {
				const { group } = workflow(file).concurrency;
				assert.notEqual(evaluate(group, pr(LABEL)), evaluate(group, pr(own[file])), file);
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

	it("every pull_request workflow with macOS/Windows legs cancels its superseded PR run", () => {
		for (const file of ["ci.yml", "read-summary-binary-parity.yml", "session-worker-compile.yml", "native-prebuilds.yml"]) {
			const { concurrency } = workflow(file);
			assert.ok(concurrency?.group, file);
			assert.match(String(concurrency.group), /github\.(ref|event\.pull_request\.number)/, file);
			assert.ok(file === "native-prebuilds.yml" || workflow(file).jobs["platform-scope"].steps.some((step) => step.run?.includes("previous_filename")), `${file} classifies renames by both paths`);
			assert.notEqual(concurrency["cancel-in-progress"], false, file);
			assert.ok(concurrency["cancel-in-progress"] !== undefined, file);
		}
	});
});
