#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const { jobs } = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const combined = jobs["macos-combined"];
const originals = ["process-kernel", "rpc-owner-lifetime", "terminal-cross-os", "inspector-handoff", "webview-kernel"];
const suites = combined?.steps.filter((step) => step.id && /run-tests\.mjs|npm run test/.test(step.run ?? ""));

// Runner allocation and required-status wiring are CI configuration contracts (#3130).
test("CI allocates one macOS runner while retaining the other matrix legs", () => {
	assert.ok(combined);
	assert.equal(combined["runs-on"], "macos-latest");
	// Pull requests run it only with the run-full-ci label (senpi#6834, ci-platform-scope.test.mjs).
	assert.equal(combined.if, "needs.platform-scope.outputs.full == 'true'");
	assert.deepEqual(Object.keys(jobs).filter((name) =>
		JSON.stringify(jobs[name]["runs-on"]).includes("macos") ||
		jobs[name].strategy?.matrix.os?.includes("macos-latest")), ["macos-combined"]);
	for (const name of originals) {
		const os = jobs[name].strategy.matrix.os;
		if (["webview-kernel", "terminal-cross-os", "inspector-handoff"].includes(name)) {
			// Linux always, Windows only for a full run (senpi#3957); never macOS.
			assert.match(os, /^\$\{\{ fromJSON\(.*'\["ubuntu-latest", "windows-latest"\]' \|\| '\["ubuntu-latest"\]'\) \}\}$/, name);
		} else {
			assert.deepEqual(os, ["ubuntu-latest"]);
		}
	}
	assert.ok(jobs["check-and-test"].needs.includes("macos-combined"));
	assert.ok(jobs["check-and-test"].steps.some((step) => step.run?.includes("needs.macos-combined.result")));
	for (const name of ["process-kernel", "terminal-cross-os", "inspector-handoff"]) {
		assert.ok(!jobs["check-and-test"].needs.includes(name), name);
	}
});

test("shared setup preserves the toolchain pins and installs and builds once", () => {
	for (const name of ["Checkout", "Setup Node.js", "Setup Bun"]) {
		assert.deepEqual(combined.steps.find((step) => step.name === name),
			jobs["webview-kernel"].steps.find((step) => step.name === name));
	}
	const install = combined.steps.find((step) => step.id === "install");
	assert.equal(install.run, "npm ci --ignore-scripts\nnpm run build\n");
	assert.equal(combined.steps.filter((step) => step.run?.includes("npm ci")).length, 1);
	assert.equal(combined.steps.filter((step) => step.run?.includes("npm run build")).length, 1);
	// A hung suite may hold the scarce macOS runner only for its own step cap; the job cap is the sum of
	// the suite step caps plus setup margin, so no single hang can stretch the job beyond that.
	assert.equal(combined["timeout-minutes"], suites.reduce((sum, step) => sum + step["timeout-minutes"], 10));
});

test("all original commands and execution guards remain with WebView last", () => {
	assert.deepEqual(suites.map((step) => step.id),
		["process", "rpc", "terminal_pty", "terminal_extension", "inspector", "webview"]);
	// Keep the macOS suite budgets from #3939 until #7192; the Linux/Windows caps can change independently.
	const macosSuiteCaps = { process: 12, rpc: 15, terminal_pty: 15, terminal_extension: 15, inspector: 20, webview: 12 };
	for (const name of originals) {
		const original = jobs[name];
		for (const step of original.steps.filter((candidate) =>
			/run-tests\.mjs|npm run test/.test(candidate.run ?? ""))) {
			const replacement = suites.find((candidate) => candidate.name === step.name);
			assert.ok(replacement, step.name);
			assert.equal(replacement.run, step.run, step.name);
			assert.equal(replacement["working-directory"], step["working-directory"], step.name);
			assert.deepEqual(replacement.env, step.env, step.name);
			assert.equal(replacement["timeout-minutes"], macosSuiteCaps[replacement.id], `${step.name} keeps its macOS cap`);
			assert.equal(replacement["continue-on-error"], undefined, step.name);
		}
		for (const step of original.steps.filter((candidate) =>
			/Require the .*executed|orphaned kernel|readiness log|exit-event compiler/.test(candidate.name))) {
			assert.ok(combined.steps.some((candidate) => candidate.name === step.name && candidate.run === step.run), step.name);
		}
	}
	assert.equal(combined.steps.filter((step) => step.run?.includes("test-temp-guard.mjs snapshot")).length, 5);
	assert.equal(combined.steps.filter((step) => step.run?.includes("test-temp-guard.mjs check")).length, 5);
});

test("suite conditions survive earlier failures but refuse failed installs, snapshots and cancellation", () => {
	for (const step of suites) {
		// Only the explicit success predicates in these real Actions expressions are supported.
		// An implicit success() or previous-suite dependency would skip work after a failure.
		const match = /^\$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' && steps\.(\w+)\.outcome == 'success' \}\}$/.exec(step.if);
		assert.ok(match, step.name);
		for (const [cancelled, install, snapshot, expected] of [
			[false, "success", "success", true],
			[false, "failure", "success", false],
			[false, "success", "failure", false],
			[true, "success", "success", false],
		]) {
			const condition = step.if.slice(3, -2)
				.replace("cancelled()", String(cancelled))
				.replace("steps.install.outcome", JSON.stringify(install))
				.replace(`steps.${match[1]}.outcome`, JSON.stringify(snapshot));
			assert.equal(Function(`return (${condition});`)(), expected, step.name);
		}
	}
	const gate = jobs["check-and-test"].steps.find((step) => step.run?.includes("ci-platform-scope.mjs verify"));
	// A full run (every main push) accepts only success; a non-full PR run may also skip it.
	for (const [full, result, expected] of [
		["true", "success", 0], ["true", "failure", 1], ["true", "cancelled", 1], ["true", "skipped", 1],
		["false", "skipped", 0], ["false", "failure", 1],
	]) {
		const needs = Object.fromEntries(jobs["check-and-test"].needs.map((name) =>
			[name, { result: name === "macos-combined" ? result : "success" }]));
		const script = gate.run.replace(/\$\{\{\s*needs\.platform-scope\.outputs\.full\s*\}\}/, full);
		const run = spawnSync("bash", ["-c", script], {
			cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
			env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) },
		});
		assert.equal(run.status, expected, `${full} ${result}: ${run.stdout}${run.stderr}`);
	}
});

test("the WebView executed check runs only after a passing WebView suite, as on base", () => {
	const check = combined.steps.find((step) => step.name === "Require the WebView suites to have executed");
	assert.equal(check.if, "${{ !cancelled() && steps.webview.outcome == 'success' }}");
});
