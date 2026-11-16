#!/usr/bin/env node
// senpi#6859: a non-empty ci_basis_receipt waives the release job's wait for the hosted "Check and test" run only when the
// "Accept or refuse the CI-basis receipt" step accepts it. Release security contract: the waiver needs a pinned sha, a
// ci_basis_head equal to it, an admin or maintain actor and well-formed inputs; an empty receipt changes nothing.
// These tests execute the step's own script and the Run release script, never a copy of their text.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { evaluateExpression, jobStep, jobSteps, workflowJob } from "./workflow-text.test-support.mjs";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const release = workflowJob(workflow, "release");
const WAIVER = "Accept or refuse the CI-basis receipt";
const waiver = jobStep(release, WAIVER);
const scriptOf = (step) => step.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, "");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const root = mkdtempSync(join(tmpdir(), "ci-basis-receipt-"));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
mkdirSync(bin);
// The fake gh answers the collaborator-permission read with FAKE_ROLE (a failed read when it is "__fail__").
writeFileSync(
	join(bin, "gh"),
	`#!/bin/sh\necho "$*" >> "${join(root, "gh-calls")}"\n[ "$FAKE_ROLE" = __fail__ ] && exit 1\necho "$FAKE_ROLE"\n`,
);
chmodSync(join(bin, "gh"), 0o755);

let runs = 0;
/** Run the waiver step's script with the dispatch inputs it reads through env. */
function runWaiver(overrides = {}) {
	const summary = join(root, `summary-${++runs}.md`);
	const env = {
		CI_BASIS_RECEIPT: "ci-basis/2026-11-16/run-42",
		CI_BASIS_HEAD: SHA,
		RELEASE_SHA: SHA,
		FORCE_TESTS: "false",
		PUBLISH_ONLY: "false",
		ACTOR: "maintainer-1",
		GH_REPO: "o/r",
		GH_TOKEN: "t",
		FAKE_ROLE: "maintain",
		...overrides,
	};
	const result = spawnSync("bash", ["-c", scriptOf(waiver)], {
		env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, ...env },
		encoding: "utf8",
	});
	const errors = result.stderr.split("\n").filter((line) => line.startsWith("::error::"));
	return { ...result, errors, summary: existsSync(summary) ? readFileSync(summary, "utf8") : null };
}

describe("ci_basis_receipt dispatch inputs and step wiring (senpi#6859)", () => {
	it("declares ci_basis_receipt and ci_basis_head as optional strings defaulting to empty", () => {
		for (const input of ["ci_basis_receipt", "ci_basis_head"]) {
			assert.match(workflow, new RegExp(`\\n      ${input}:\\n        description: [^\\n]+\\n        required: false\\n        type: string\\n        default: ''\\n`));
		}
	});

	it("runs the waiver step only for a non-empty receipt, before Checkout, with every input passed through env", () => {
		const condition = waiver.match(/\n {8}if: (.*)/)?.[1];
		assert.ok(condition, "expected the waiver step's if");
		assert.equal(evaluateExpression(condition, { inputs: { ci_basis_receipt: "" } }), false);
		assert.equal(evaluateExpression(condition, { inputs: { ci_basis_receipt: "r" } }), true);
		const names = jobSteps(release).map((step) => step.name);
		assert.equal(names.indexOf(WAIVER), names.indexOf("Checkout") - 1, names.join(", "));
		assert.doesNotMatch(waiver, /continue-on-error/);
		assert.doesNotMatch(scriptOf(waiver), /\$\{\{/, "inputs reach the script through env only");
		assert.match(waiver, /ACTOR: \$\{\{ github\.triggering_actor \}\}/);
		assert.match(waiver, /RELEASE_SHA: \$\{\{ inputs\.sha \}\}/);
		assert.match(waiver, /CI_BASIS_HEAD: \$\{\{ inputs\.ci_basis_head \}\}/);
	});
});

describe("the waiver step refuses each defeat condition with its own error (senpi#6859)", () => {
	const refusals = [
		["no pinned sha", { RELEASE_SHA: "" }, /the sha input is empty/],
		["a head that is not the pinned sha", { CI_BASIS_HEAD: OTHER }, /is not the pinned release commit/],
		["a write-role actor", { FAKE_ROLE: "write" }, /has the 'write' role; only admin or maintain/],
		["a triage-role actor", { FAKE_ROLE: "triage" }, /has the 'triage' role/],
		["an actor whose role cannot be read", { FAKE_ROLE: "__fail__" }, /could not read the repository role of maintainer-1/],
		["a missing actor", { ACTOR: "" }, /triggering actor is missing/],
		["a short head", { CI_BASIS_HEAD: SHA.slice(0, 12), RELEASE_SHA: SHA.slice(0, 12) }, /ci_basis_head must be a full 40-character/],
		["an uppercase head", { CI_BASIS_HEAD: SHA.toUpperCase(), RELEASE_SHA: SHA.toUpperCase() }, /ci_basis_head must be a full 40-character/],
		["a 201-character receipt", { CI_BASIS_RECEIPT: "r".repeat(201) }, /201 characters; at most 200/],
		["a receipt with a newline", { CI_BASIS_RECEIPT: "ok\n::warning::injected" }, /printable ASCII with no newline/],
		["a receipt with a control character", { CI_BASIS_RECEIPT: "ok\u0007" }, /printable ASCII with no newline/],
		["a receipt with a non-ASCII character", { CI_BASIS_RECEIPT: "réceipt" }, /printable ASCII/],
		["an empty receipt reaching the script", { CI_BASIS_RECEIPT: "" }, /ci_basis_receipt is empty/],
		["a force_tests release", { FORCE_TESTS: "true" }, /a force_tests release does not have/],
		["a publish-only run", { PUBLISH_ONLY: "true" }, /a publish-only run does not have/],
	];
	for (const [label, overrides, message] of refusals) {
		it(`refuses ${label}`, () => {
			const result = runWaiver(overrides);
			assert.equal(result.status, 1, result.stdout);
			assert.equal(result.errors.length, 1, result.stderr);
			assert.match(result.errors[0], message);
			assert.equal(result.summary, null, "a refused receipt writes no waiver to the summary");
			assert.doesNotMatch(result.stdout, /waived/);
		});
	}

	it("reports every refusal at once", () => {
		const result = runWaiver({ RELEASE_SHA: "", CI_BASIS_HEAD: "x", FAKE_ROLE: "read" });
		assert.equal(result.status, 1);
		assert.equal(result.errors.length, 3, result.stderr);
	});
});

describe("an accepted receipt is logged and summarized (senpi#6859)", () => {
	for (const role of ["admin", "maintain"]) {
		it(`accepts a well-formed receipt for the pinned sha from a ${role} actor`, () => {
			const result = runWaiver({ FAKE_ROLE: role, CI_BASIS_RECEIPT: "r".repeat(200) });
			assert.equal(result.status, 0, result.stderr);
			const lines = [`CI-basis receipt: ${"r".repeat(200)}`, `CI-basis head: ${SHA}`, "Actor: maintainer-1", "hosted CI wait waived by ci_basis_receipt"];
			assert.deepEqual(result.stdout.trim().split("\n"), lines);
			assert.deepEqual(result.summary.trim().split("\n"), lines);
			assert.match(readFileSync(join(root, "gh-calls"), "utf8"), /^api repos\/o\/r\/collaborators\/maintainer-1\/permission --jq \.role_name$/m);
		});
	}
});

describe("Run release passes the waiver to release.mjs only for a non-empty receipt (senpi#6859)", () => {
	const script = scriptOf(jobStep(release, "Run release"))
		.replaceAll("${{ inputs.force_tests }}", "false")
		.replaceAll("${{ inputs.dry_run }}", "true");
	writeFileSync(join(bin, "npm"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(join(root, "npm-args.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
	chmodSync(join(bin, "npm"), 0o755);
	const argsFor = (receipt) => {
		const result = spawnSync("bash", ["-c", script], {
			cwd: root,
			env: { PATH: `${bin}:${process.env.PATH}`, RELEASE_SHA: SHA, RELEASE_VERSION: "2026.11.16", CI_BASIS_RECEIPT: receipt },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(readFileSync(join(root, "npm-args.json"), "utf8"));
	};

	it("keeps the release's arguments, and so its hosted CI wait, unchanged for an empty receipt", () => {
		assert.match(jobStep(release, "Run release"), /CI_BASIS_RECEIPT: \$\{\{ inputs\.ci_basis_receipt \}\}/);
		assert.deepEqual(argsFor(""), ["run", "release", "--", "--version", "2026.11.16", "--dry-run", "--sha", SHA]);
	});

	it("adds --ci-basis-receipt for an accepted receipt", () => {
		assert.deepEqual(argsFor("rcpt 1").slice(-4), ["--sha", SHA, "--ci-basis-receipt", "rcpt 1"]);
	});
});

describe("release.mjs --ci-basis-receipt (senpi#6859)", () => {
	const releaseCli = (args) =>
		spawnSync(process.execPath, [new URL("./release.mjs", import.meta.url).pathname, ...args], { cwd: root, encoding: "utf8" });

	it("needs --sha and refuses --force-tests and --tested-sha", () => {
		for (const [args, message] of [
			[["--ci-basis-receipt", "r"], /--ci-basis-receipt needs --sha/],
			[["--ci-basis-receipt", "r", "--sha", SHA, "--force-tests"], /--force-tests and --tested-sha releases do not have/],
			[["--ci-basis-receipt", "r", "--sha", SHA, "--tested-sha", SHA, "--shard-results", root], /--force-tests and --tested-sha/],
		]) {
			const result = releaseCli(args);
			assert.equal(result.status, 1, args.join(" "));
			assert.match(result.stderr, message);
		}
	});
});
