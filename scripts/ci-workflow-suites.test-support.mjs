#!/usr/bin/env node
import assert from "node:assert/strict";
import { posix } from "node:path";

// Reads which CI step runs which test suite from .github/workflows/ci.yml, for scripts/ci-workspace-coverage.test.mjs
// (senpi#6620, senpi#6631). The workflow is read as text, so no YAML parser is needed.

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

const MANAGERS = new Set(["npm", "pnpm", "bun", "yarn"]);
// Package-manager options that take a value, and what the value selects; other known options take none.
const DIR_FLAGS = new Set(["--cwd", "--prefix", "--dir", "-C"]);
const WORKSPACE_FLAGS = new Set(["--workspace", "-w", "--filter", "-F"]);
const ALL_WORKSPACES_FLAGS = new Set(["--workspaces", "-ws", "--recursive", "-r"]);
const PLAIN_FLAGS = new Set(["--if-present", "--silent", "-s"]);
// `npm test` and its aliases `npm t` / `npm tst` (pnpm and yarn accept `test` too).
const TEST_WORDS = new Set(["test", "t", "tst"]);

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

/** Suites run more than once per CI run, as "suite: owner, owner". */
export const runTwice = (owners) => [...owners].filter(([, list]) => list.length > 1).map(([suite, list]) => `${suite}: ${list.join(", ")}`);


/** The workflow with `step` inserted as the first step of job `id`. */
export function withStep(text, id, step) {
	const block = jobsOf(text).get(id);
	assert.ok(block, `the workflow has no ${id} job`);
	const steps = block.indexOf("\n    steps:\n") + "\n    steps:\n".length;
	return text.replace(block, block.slice(0, steps) + step + block.slice(steps));
}

/**
 * The scan for one repository: `workspaces` as `resolveWorkspaceDirectories` returns them, and `extraRuns` as
 * suite -> { job: reason } for the extra runs kept on purpose.
 */
export function createSuiteScanner({ workspaces, extraRuns }) {
	const tested = workspaces.filter((workspace) => typeof workspace.scripts.test === "string");
	const byName = new Map(workspaces.flatMap((workspace) => [[workspace.name, workspace.relativePath], [workspace.relativePath, workspace.relativePath]]));

	/** A workspace path from a name, a path, or a path with "./" or a trailing "/"; "root" for the repository root. */
	const workspaceOf = (value, from = "root") => {
		if (byName.has(value)) return byName.get(value);
		const path = posix.normalize(posix.join(from === "root" ? "." : from, value)).replace(/\/$/, "");
		return path === "." ? "root" : path;
	};

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

	/**
	 * Every step of every job, scanned for the suites it runs in full: suite -> one label per run (a suite run twice in
	 * the same job is listed twice), with the extra runs taken out, plus the ids of the jobs that own those runs.
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
		for (const [suite, jobs] of Object.entries(extraRuns)) {
			for (const job of Object.keys(jobs)) {
				const list = owners.get(suite) ?? [];
				assert.ok(list.includes(job), `EXTRA_RUNS (extraRuns) lists ${job} for ${suite}, but that job no longer runs it`);
				list.splice(list.indexOf(job), 1);
			}
		}
		const suiteJobs = [...new Set([...owners.values()].flat().map((label) => label.replace(/ \(.*\)$/, "")))];
		return { owners, suiteJobs };
	}

	/** Suite jobs missing from the "Check and test" fan-in, whose failure would then not block a merge. */
	function missingFromFanIn(text) {
		const needs = jobsOf(text).get("check-and-test")?.match(/\n {4}needs:\s*\[([^\]]*)\]/)?.[1];
		assert.ok(needs, "check-and-test must list its needs as a [...] list");
		const listed = needs.split(",").map((name) => name.trim()).filter(Boolean);
		return suiteOwnership(text).suiteJobs.filter((name) => !listed.includes(name));
	}

	return { suiteOwnership, missingFromFanIn };
}
