#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM_JOBS } from "./ci-platform-scope.mjs";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

// Contract (senpi#6620, senpi#6631): every workspace with a `test` script runs in exactly one hosted CI step, or is
// named below as not run there, and every job that runs a suite gates merges. Splitting the workspace suites into
// matrix groups made it easy to drop a workspace from every group (its suite would then silently stop running), to
// run one twice (as senpi-codemode was), or to leave a suite's job out of the fan-in.
const WORKFLOW = ".github/workflows/ci.yml";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), "utf8");
const workspaces = await resolveWorkspaceDirectories(root);
const tested = workspaces.filter((workspace) => typeof workspace.scripts.test === "string");

/** Workspaces with a `test` script that no hosted CI job runs today, each with the reason. */
const NOT_IN_HOSTED_CI = {
	"packages/chord": "no hosted job has run this suite; see senpi#6621",
	"packages/evals": "model-backed eval suites that spend tokens by design",
	"packages/session-backends/sqlite-bun": "no hosted job has run this suite; see senpi#6621",
	"packages/session-backends/sqlite-node": "no hosted job has run this suite; see senpi#6621",
};

/** Extra runs of a suite in another job, kept on purpose; each must still exist, so a stale entry fails. */
const EXTRA_RUNS = {
	"packages/pty": {
		"terminal-cross-os": "the cross-OS terminal suite runs the PTY tests on Windows too; its Linux leg repeats the matrix run",
		"macos-combined": "the PTY tests on macOS",
	},
};

/** The workflow's jobs as id -> YAML text, read from the text so no YAML parser is needed. */
function jobsOf(text) {
	const body = text.slice(text.search(/^jobs:\n/m));
	return new Map([...body.matchAll(/^  ([\w-]+):\n[\s\S]*?(?=^  [\w-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1], match[0]]));
}

/** One job's steps as { run, cwd }; a block-scalar `run: |` or `run: >` is read whole and joined into one line. */
function stepsOf(block) {
	return block.split(/\n {6}- /).slice(1).map((dashed) => {
		// The first key sits on the `- ` line; indent it like the step's other keys.
		const step = `        ${dashed}`;
		const lines = step.split("\n");
		const at = lines.findIndex((line) => /^ {8}run: /.test(line));
		let run = "";
		if (at !== -1) {
			const value = lines[at].replace(/^ {8}run: /, "");
			const body = [];
			if (/^[|>][-+]?\s*$/.test(value)) {
				for (const line of lines.slice(at + 1)) {
					if (line.trim() && !/^ {9}/.test(line)) break;
					body.push(line);
				}
			} else body.push(value);
			const literal = /^\|/.test(value);
			run = body.join(literal ? "\n" : " ").replace(/\\\n\s*/g, " ").replace(/[ \t]+/g, " ").trim();
		}
		return { run, cwd: step.match(/^ {8}working-directory: (\S+)/m)?.[1], name: step.match(/^ {8}name: (.+)$/m)?.[1] };
	});
}

const byName = new Map(workspaces.flatMap((workspace) => [[workspace.name, workspace.relativePath], [workspace.relativePath, workspace.relativePath]]));
const MANAGERS = new Set(["npm", "pnpm", "bun", "yarn"]);
// Package-manager options that take a value, and what the value selects; other known options take none.
const DIR_FLAGS = new Set(["--cwd", "--prefix", "--dir", "-C"]);
const WORKSPACE_FLAGS = new Set(["--workspace", "-w", "--filter", "-F"]);
const ALL_WORKSPACES_FLAGS = new Set(["--workspaces", "-ws", "--recursive", "-r"]);
const PLAIN_FLAGS = new Set(["--if-present", "--silent", "-s"]);
// `npm test` and its aliases `npm t` / `npm tst` (pnpm and yarn accept `test` too).
const TEST_WORDS = new Set(["test", "t", "tst"]);

/** A workspace path from a name, a path, or a path with "./" or a trailing "/"; "root" for the repository root. */
const workspaceOf = (value, from = "root") => {
	if (byName.has(value)) return byName.get(value);
	const path = posix.normalize(posix.join(from === "root" ? "." : from, value)).replace(/\/$/, "");
	return path === "." ? "root" : path;
};

/**
 * One shell command, from its first word: environment assignments are skipped and the
 * `node scripts/run-tests.mjs <command>` wrapper is looked through. A package manager counts only here, never as an
 * argument of another command (`echo npm test`, `node scripts/foo.mjs --pm npm test`).
 */
function commandWords(command) {
	const words = command.split(/\s+/).filter(Boolean);
	while (/^[A-Za-z_][\w]*=/.test(words[0] ?? "")) words.shift();
	if (words[0] === "node" && /(^|\/)run-tests\.mjs$/.test(words[1] ?? "")) words.splice(0, 2);
	return words;
}

/**
 * The script a package-manager call runs and where: { script, target } with target a workspace path or "root", or
 * { unresolved: true } when it runs a test script the parser cannot place. Shapes: `<pm> [options] run <script>`,
 * `<pm> [options] test` (not `bun test`, Bun's own runner on the files it names), and `yarn workspace <name> <script>`.
 */
function scriptCall(words, dir) {
	const [manager, ...rest] = words;
	const forwarded = rest.indexOf("--");
	const args = forwarded === -1 ? rest : rest.slice(0, forwarded);
	let target = dir;
	let workspace;
	let unknownFlag = false;
	const positional = [];
	for (let index = 0; index < args.length; index += 1) {
		const [flag, inline] = args[index].split(/=(.*)/s);
		if (DIR_FLAGS.has(flag)) target = workspaceOf(inline ?? args[(index += 1)], dir);
		else if (WORKSPACE_FLAGS.has(flag)) workspace = inline ?? args[(index += 1)];
		else if (ALL_WORKSPACES_FLAGS.has(flag)) workspace = "root";
		else if (flag.startsWith("-")) unknownFlag ||= !PLAIN_FLAGS.has(flag);
		else positional.push(flag);
	}
	if (manager === "yarn" && positional[0] === "workspace") workspace = positional.splice(0, 2)[1];
	const script = positional[0] === "run" || positional[0] === "run-script" ? positional[1] : TEST_WORDS.has(positional[0]) && manager !== "bun" ? "test" : undefined;
	// `bun test <files>` runs Bun's own test runner on those files, which is not the package's `test` script.
	if (manager === "bun" && positional[0] === "test" && !unknownFlag) return undefined;
	const mentionsTest = args.some((word) => TEST_WORDS.has(word) || word === "test:scripts");
	// An option the parser does not know may take a value, so the words after it cannot be read as the script.
	if (mentionsTest && (unknownFlag || (script !== "test" && script !== "test:scripts"))) return { unresolved: true };
	if (!script) return undefined;
	const resolved = workspace === undefined ? target : workspace === "root" ? "root" : workspaceOf(workspace);
	return { script, target: resolved };
}

/**
 * The suites one step runs in full (workspace paths, "scripts", or "matrix" for the run-workspaces matrix command),
 * plus every package-manager test command whose target the parser could not place: the check fails on those
 * instead of reading them as running nothing.
 */
function suitesRunBy({ run, cwd }) {
	const suites = [];
	const unrecognised = [];
	const runner = run.match(/run-workspaces\.mjs ((?:\S+ )*?)test(?![\w:-])/);
	if (runner) {
		if (runner[1].includes("${{ matrix.workspaces }}")) suites.push("matrix");
		const listed = [...runner[1].matchAll(/--workspace[= ](\S+)/g)].map((match) => byName.get(match[1]) ?? match[1]);
		suites.push(...(listed.length > 0 || runner[1].includes("matrix") ? listed : tested.map((workspace) => workspace.relativePath)));
	}
	const paths = new Set(tested.map((workspace) => workspace.relativePath));
	const dirs = [cwd ?? "root"];
	for (const raw of run.split(/\n|&&|\|\||;|\|/)) {
		const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
		const closes = (raw.match(/\)+\s*$/)?.[0].trim().length) ?? 0;
		for (let index = 0; index < opens; index += 1) dirs.push(dirs.at(-1));
		const command = raw.replace(/^\s*\(+/, "").replace(/\)+\s*$/, "").trim();
		const words = commandWords(command);
		if (words[0] === "cd" && words[1]) dirs[dirs.length - 1] = workspaceOf(words[1], dirs.at(-1));
		const call = MANAGERS.has(words[0]) ? scriptCall(words, dirs.at(-1)) : undefined;
		if (call?.unresolved) unrecognised.push(command);
		else if (call?.script === "test") {
			if (call.target === "root") suites.push(...paths);
			else if (paths.has(call.target)) suites.push(call.target);
			else unrecognised.push(command);
		}
		// `bun run test:scripts` is the deliberate Bun-launched twin of the npm run, so only npm counts as the scripts suite.
		else if (call?.script === "test:scripts" && words[0] === "npm") {
			if (call.target === "root") suites.push("scripts");
			else unrecognised.push(command);
		}
		for (let index = 0; index < closes && dirs.length > 1; index += 1) dirs.pop();
	}
	if (cwd === "packages/coding-agent" && /\bvitest run --shard=/.test(run)) suites.push("packages/coding-agent");
	return { suites, unrecognised };
}

function matrixGroups(block) {
	const include = block.match(/\n {8}include:\n([\s\S]*?)\n {4}runs-on:/)?.[1];
	assert.ok(include, "the workspace matrix job must list its groups under strategy.matrix.include");
	return include.split(/\n {10}- /).filter((entry) => entry.trim()).map((entry) => {
		const group = entry.match(/group: (.+)/)?.[1];
		const value = entry.slice(entry.indexOf("workspaces:") + "workspaces:".length).replace(/^ >-/, "").trim();
		const tokens = value.split(/\s+/);
		assert.ok(group && tokens.length % 2 === 0, `unreadable matrix entry: ${entry}`);
		const paths = [];
		for (let index = 0; index < tokens.length; index += 2) {
			assert.equal(tokens[index], "--workspace", `group "${group}": ${value}`);
			paths.push(tokens[index + 1]);
		}
		return { group, paths };
	});
}

/**
 * Every step of every job, scanned for the suites it runs in full: suite -> one label per run (a suite run twice in
 * the same job is listed twice), with the EXTRA_RUNS taken out, plus the ids of the jobs that own those runs.
 */
function suiteOwnership(text) {
	const owners = new Map();
	const claim = (suite, label) => owners.set(suite, [...(owners.get(suite) ?? []), label]);
	const unrecognised = [];
	for (const [id, block] of jobsOf(text)) {
		for (const [index, step] of stepsOf(block).entries()) {
			const found = suitesRunBy(step);
			for (const command of found.unrecognised) unrecognised.push(`unrecognised test invocation in ${id}/${step.name ?? `step ${index + 1}`}: ${command}; teach the parser or rewrite the step`);
			for (const suite of found.suites) {
				if (suite !== "matrix") claim(suite, id);
				else for (const { group, paths } of matrixGroups(block)) for (const path of paths) claim(path, `${id} (${group})`);
			}
		}
	}
	assert.deepEqual(unrecognised, [], "every package-manager test command must name a workspace the parser can resolve");
	for (const [suite, jobs] of Object.entries(EXTRA_RUNS)) {
		for (const job of Object.keys(jobs)) {
			const list = owners.get(suite) ?? [];
			assert.ok(list.includes(job), `EXTRA_RUNS lists ${job} for ${suite}, but that job no longer runs it`);
			list.splice(list.indexOf(job), 1);
		}
	}
	const suiteJobs = [...new Set([...owners.values()].flat().map((label) => label.replace(/ \(.*\)$/, "")))];
	return { owners, suiteJobs };
}

/** Suites run more than once per CI run, as "suite: owner, owner". */
const runTwice = (owners) => [...owners].filter(([, list]) => list.length > 1).map(([suite, list]) => `${suite}: ${list.join(", ")}`);

/** Suite jobs missing from the "Check and test" fan-in, whose failure would then not block a merge. */
function missingFromFanIn(text) {
	const needs = jobsOf(text).get("check-and-test")?.match(/\n {4}needs:\s*\[([^\]]*)\]/)?.[1];
	assert.ok(needs, "check-and-test must list its needs as a [...] list");
	const listed = needs.split(",").map((name) => name.trim()).filter(Boolean);
	return suiteOwnership(text).suiteJobs.filter((name) => !listed.includes(name));
}

/** The workflow with `step` inserted as the first step of job `id`. */
function withStep(text, id, step) {
	const block = jobsOf(text).get(id);
	assert.ok(block, `${WORKFLOW} has no ${id} job`);
	const steps = block.indexOf("\n    steps:\n") + "\n    steps:\n".length;
	return text.replace(block, block.slice(0, steps) + step + block.slice(steps));
}

test("every job that runs a suite is in the Check and test fan-in", () => {
	assert.deepEqual(missingFromFanIn(workflow), [], `add these jobs to check-and-test.needs in ${WORKFLOW}`);
});

test("the fan-in check follows the workflow's own suite jobs, whatever they are named", () => {
	// A renamed suite job that is also dropped from the fan-in must be reported under its new name.
	const renamed = workflow.replace(/^  codemode-tests:\n/m, "  codemode-suite:\n").replace(/^ {8}codemode-tests,\n/m, "");
	assert.deepEqual(missingFromFanIn(renamed), ["codemode-suite"]);
});

test("a second run is caught in another job, the same job, a block scalar, and each package-manager shape listed", () => {
	const ai = "packages/ai: test-workspaces (ai), test-scripts";
	const cases = [
		// The codemode package suite added back to codemode-gate would run it twice per CI run again.
		["codemode-gate", "      - run: bun run --cwd packages/senpi-codemode test\n", "packages/senpi-codemode: codemode-gate, codemode-tests"],
		// A second step of the job that already owns the suite.
		["codemode-tests", "      - run: bun run --cwd packages/senpi-codemode test\n", "packages/senpi-codemode: codemode-tests, codemode-tests"],
		// The same command in a block scalar, on the line after `run: |`.
		["codemode-gate", "      - name: Again\n        run: |\n          echo start\n          bun run --cwd packages/senpi-codemode test\n", "packages/senpi-codemode: codemode-gate, codemode-tests"],
		// A matrix-owned workspace run again through each package-manager shape.
		["test-scripts", "      - run: bun run --cwd packages/ai test\n", ai],
		["test-scripts", "      - run: npm run test --workspace @earendil-works/pi-ai\n", ai],
		["test-scripts", "      - working-directory: packages/ai\n        run: npm test\n", ai],
		["test-scripts", "      - working-directory: packages/ai\n        run: bun run test\n", ai],
		["test-scripts", "      - run: npm test -w packages/ai\n", ai],
		["test-scripts", "      - run: npm run test -w @earendil-works/pi-ai\n", ai],
		["test-scripts", "      - run: pnpm --filter @earendil-works/pi-ai test\n", ai],
		["test-scripts", "      - run: bun --cwd packages/ai run test\n", ai],
		["test-scripts", "      - run: cd packages/ai && npm test\n", ai],
		["test-scripts", "      - run: npm run --cwd ./packages/ai test\n", ai],
		["test-scripts", "      - run: yarn workspace @earendil-works/pi-ai test\n", ai],
		["test-scripts", "      - run: (cd packages/ai && npm test)\n", ai],
		["test-scripts", "      - run: npm t -w packages/ai\n", ai],
	];
	const missed = cases.filter(([job, step, expected]) => !runTwice(suiteOwnership(withStep(workflow, job, step)).owners).includes(expected))
		.map(([job, step]) => `${job}: ${step.trim()}`);
	assert.deepEqual(missed, [], "these second runs were not reported");
	// `bun test <files>` is Bun's own runner on the files it names, not the package's `test` script.
	const bunRunner = withStep(workflow, "test-scripts", "      - working-directory: packages/ai\n        run: bun test test/stream.test.ts\n");
	assert.deepEqual(runTwice(suiteOwnership(bunRunner).owners), []);
});

test("a test command the parser cannot place fails the check instead of counting as no run", () => {
	for (const command of ["npm --loglevel warn test --workspace packages/ai", "cd crates/senpi-pty && npm test", "yarn workspace @earendil-works/not-a-package test"]) {
		const text = withStep(workflow, "test-scripts", `      - name: Probe\n        run: ${command}\n`);
		assert.throws(() => suiteOwnership(text), (error) => error.message.includes(
			`unrecognised test invocation in test-scripts/Probe: ${command.replace(/^cd \S+ && /, "")}; teach the parser or rewrite the step`), command);
	}
});

test("a package manager counts only where a command starts, not as another command's argument", () => {
	for (const command of ["echo npm test", "node scripts/foo.mjs --pm npm test", "FOO=1 echo npm run test"]) {
		const text = withStep(workflow, "test-scripts", `      - name: Probe\n        run: ${command}\n`);
		assert.deepEqual(runTwice(suiteOwnership(text).owners), [], command);
	}
});

test("no suite job is a platform job the fan-in lets a non-full run skip", () => {
	// ci-platform-scope.mjs verify accepts `skipped` for PLATFORM_JOBS, so a suite there could silently not run.
	const skippable = suiteOwnership(workflow).suiteJobs.filter((name) => PLATFORM_JOBS.includes(name));
	assert.deepEqual(skippable, [], "suite jobs must not be in PLATFORM_JOBS in scripts/ci-platform-scope.mjs");
});

test("every workspace test script runs in exactly one CI step or is named as not run in hosted CI", () => {
	const paths = tested.map((workspace) => workspace.relativePath);
	const { owners } = suiteOwnership(workflow);
	assert.equal(owners.get("scripts")?.length, 1, "the scripts suite must run in exactly one step");
	owners.delete("scripts");
	for (const path of Object.keys(NOT_IN_HOSTED_CI)) owners.set(path, [...(owners.get(path) ?? []), "NOT_IN_HOSTED_CI"]);

	const unowned = paths.filter((path) => !owners.has(path));
	assert.deepEqual(unowned, [],
		`These workspaces have a test script that no CI job runs. Add each to a test-workspaces matrix group in ${WORKFLOW}, ` +
		`or to NOT_IN_HOSTED_CI in scripts/ci-workspace-coverage.test.mjs with the reason.`);
	assert.deepEqual(runTwice(owners), [], "a workspace suite must run once per CI run");
	// --if-present skips a workspace without a test script, so a stale entry would run nothing without failing.
	const stale = [...owners.keys()].filter((path) => !paths.includes(path));
	assert.deepEqual(stale, [], `listed workspaces with no test script; remove them from ${WORKFLOW} or this file`);
});
