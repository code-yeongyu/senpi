#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/ci.yml";

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowFields(value, allowed, label) {
	if (!record(value)) throw new Error(`${label} must be a mapping`);
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${label} uses "${key}", which pre-push does not reproduce`);
	}
}

function literalEnv(value = {}, label) {
	if (!record(value)) throw new Error(`${label} env must be a mapping`);
	for (const [key, entry] of Object.entries(value)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string" || entry.includes("${{")) {
			throw new Error(`${label} env "${key}" must be a literal string`);
		}
	}
	return value;
}

// The workflow owns both the commands and the explicit CI-only exclusions.
export function checkSteps(source) {
	const workflow = parse(source);
	const job = workflow?.jobs?.check;
	if (!Array.isArray(job?.steps)) throw new Error(`${WORKFLOW} has no jobs.check.steps`);
	allowFields(job, ["name", "runs-on", "timeout-minutes", "permissions", "env", "defaults", "steps"], "check job");
	const defaults = { ...workflow.defaults, ...job.defaults };
	for (const [label, value] of [
		["workflow defaults", workflow.defaults],
		["check job defaults", job.defaults],
	]) {
		if (value === undefined) continue;
		allowFields(value, ["run"], label);
		allowFields(value.run, ["shell"], `${label}.run`);
	}
	const env = { ...literalEnv(workflow.env, "workflow"), ...literalEnv(job.env, "check job") };
	const steps = [];
	for (const [index, step] of job.steps.entries()) {
		if (typeof step?.id === "string" && step.id.startsWith("ci_only_")) continue;
		const name = step?.name ?? `step ${index + 1}`;
		const label = `step "${name}"`;
		allowFields(step, ["name", "id", "run", "env", "shell"], label);
		const shell = "shell" in step ? step.shell : defaults.run?.shell;
		if (shell !== "bash") {
			throw new Error(`${label} must specify the GitHub Actions bash shell`);
		}
		if (typeof step.run !== "string" || !step.run.trim() || step.run.includes("${{")) {
			throw new Error(`${label} must have a nonempty run command without GitHub Actions expressions`);
		}
		steps.push({ name, run: step.run, env: { ...env, ...literalEnv(step.env, label) } });
	}
	if (steps.length === 0) throw new Error(`${WORKFLOW} has no local check steps`);
	return steps;
}

function git(...args) {
	const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function run(name, command, args, env = process.env) {
	console.error(`pre-push: ${name}`);
	const result = spawnSync(command, args, { env, stdio: "inherit" });
	if (result.error?.code === "ENOENT") throw new Error(`"${command}" is not on PATH; install it and retry`);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${name} failed (${result.signal ?? `exit ${result.status}`})`);
}

function main() {
	const pushed = readFileSync(0, "utf8")
		.trim()
		.split("\n")
		.map((line) => line.split(/\s+/))
		.filter(([, sha, ref]) => ref?.startsWith("refs/heads/") && !/^0+$/.test(sha));
	if (!pushed.length) return;
	const head = git("rev-parse", "HEAD");
	if (pushed.some(([, sha]) => sha !== head)) {
		throw new Error("the pushed commit is not HEAD; check it out and push again");
	}
	if (git("status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")) {
		throw new Error("the working tree is dirty; commit or move changes out of the tree before pushing");
	}
	const steps = checkSteps(readFileSync(WORKFLOW, "utf8"));
	const localEnv = { ...process.env };
	delete localEnv.BASH_ENV;
	for (const { name, run: body, env } of steps) {
		run(name, "bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", body], { ...localEnv, ...env });
	}
	// This is the same checker as changelog-gate.yml, but only GitHub knows the
	// PR base SHA and labels. Locally require a fragment without a label waiver.
	run(
		"Changelog and change fragments (against local origin/main)",
		process.execPath,
		["scripts/check-pr-changelog.mjs", "--base", "refs/remotes/origin/main"],
		{ ...process.env, CHANGELOG_GATE_LABELS: "" },
	);
	console.error("pre-push: fast checks passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`pre-push: refused: ${error.message}`);
		process.exitCode = 1;
	}
}
