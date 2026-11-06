#!/usr/bin/env node
/**
 * The in-job suite `--force-tests` runs (senpi#2291, senpi#6139). It runs the same tests as `CI=1 npm test`, every
 * test once: `test:scripts`, then each workspace's own `test` script one at a time in path order, then
 * packages/coding-agent as `FORCED_CODING_AGENT_SHARDS` parallel `vitest --shard=i/N` runs, the split
 * `.github/workflows/ci.yml` uses. Each step runs under `release-forced-test-supervisor.mjs`, which SIGKILLs its
 * whole process group when the suite's one shared budget runs out, hung workers included.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

/**
 * Budget for the whole forced suite. A forced release on 2026-11-06 (run 42284532624) measured coding-agent at
 * 98.8 min serial and every other workspace at about 8 min together. Two shards bring coding-agent to about
 * 50 min, so the suite needs about 60 min and this budget leaves almost twice that, while a real hang still
 * fails here, inside the release job's `timeout-minutes` (`.github/workflows/publish-npm.yml`).
 */
export const FORCED_TEST_SUITE_TIMEOUT_MS = 110 * 60_000;

export const CODING_AGENT_WORKSPACE = "packages/coding-agent";

/**
 * With `CI` set, every coding-agent vitest run is capped at two fork workers (packages/coding-agent/vitest.config.ts),
 * so a serial run used half of the release runner's 4 vCPUs (ubuntu-latest). Two shards run four forks, one per
 * vCPU: the whole runner, without the oversubscription that config warns makes subprocess-heavy tests flake and
 * the forks pool hang.
 */
export const FORCED_CODING_AGENT_SHARDS = 2;

const SUPERVISOR = fileURLToPath(new URL("./release-forced-test-supervisor.mjs", import.meta.url));
const SUPERVISOR_TIMEOUT_EXIT = 124;
const RUN_WORKSPACES = fileURLToPath(new URL("./run-workspaces.mjs", import.meta.url));

/**
 * The forced suite's steps: `serial` runs one after another, then `parallel` (the coding-agent shards) runs at once.
 * @param {{rootDirectory: string, workspaces: Array<{relativePath: string, scripts: Record<string, string>}>, shards?: number}} input
 * @returns {{serial: Step[], parallel: Step[]}}
 * @typedef {{label: string, cwd: string, bin: string, args: string[]}} Step
 */
export function planForcedTestSuite({ rootDirectory, workspaces, shards = FORCED_CODING_AGENT_SHARDS }) {
	const tested = workspaces.filter((workspace) => typeof workspace.scripts.test === "string");
	if (!tested.some((workspace) => workspace.relativePath === CODING_AGENT_WORKSPACE)) {
		throw new Error(`${CODING_AGENT_WORKSPACE} has no test script to shard`);
	}
	const workspaceTest = (relativePath, forwarded) => ({
		cwd: rootDirectory,
		bin: process.execPath,
		args: [RUN_WORKSPACES, "--workspace", relativePath, "test", ...forwarded],
	});
	const serial = [
		{ label: "scripts", cwd: rootDirectory, bin: "npm", args: ["run", "test:scripts"] },
		...tested
			.filter((workspace) => workspace.relativePath !== CODING_AGENT_WORKSPACE)
			.map((workspace) => ({ label: workspace.relativePath, ...workspaceTest(workspace.relativePath, []) })),
	];
	const parallel = Array.from({ length: shards }, (_, index) => ({
		label: `${CODING_AGENT_WORKSPACE} shard ${index + 1}/${shards}`,
		...workspaceTest(CODING_AGENT_WORKSPACE, ["--", `--shard=${index + 1}/${shards}`]),
	}));
	return { serial, parallel };
}

const minutes = (ms) => (ms / 60_000).toFixed(1);

/** Prefix a step's output lines with its label; GitHub workflow commands (`::error ...`) stay at line start. */
function relay(stream, label, target) {
	createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
		target.write(line.startsWith("::") ? `${line}\n` : `[${label}] ${line}\n`);
	});
}

/** Run one step under the supervisor. Resolves on the supervisor's exit, never waiting on a pipe an orphan holds. */
function runStep(step, timeoutMs, env) {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SUPERVISOR, String(Math.max(1, timeoutMs)), step.bin, ...step.args], {
			cwd: step.cwd,
			env: { ...env, CI: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		relay(child.stdout, step.label, process.stdout);
		relay(child.stderr, step.label, process.stderr);
		child.stdout.unref?.();
		child.stderr.unref?.();
		const settle = (outcome) => resolve({ step, elapsedMs: Date.now() - startedAt, ...outcome });
		child.once("error", (error) => settle({ status: null, error }));
		child.once("exit", (code, signal) =>
			settle({ status: code ?? signal, timedOut: code === SUPERVISOR_TIMEOUT_EXIT }),
		);
	});
}

function verdictOf(result) {
	if (result.error) return `could not start (${result.error.message})`;
	if (result.timedOut) return `stopped at the budget after ${minutes(result.elapsedMs)} min`;
	return result.status === 0 ? `passed in ${minutes(result.elapsedMs)} min` : `failed (exit ${result.status}) in ${minutes(result.elapsedMs)} min`;
}

/**
 * Run the forced suite. Fails naming every failed step, or, when the budget runs out, naming each step still
 * running and how long it ran; a slow suite and a stuck step both end there, and the wall lines tell them apart.
 * @param {{plan?: {serial: Step[], parallel: Step[]}, timeoutMs?: number, env?: NodeJS.ProcessEnv, log?: (line: string) => void}} [options]
 */
export async function runForcedTestSuite({
	plan,
	timeoutMs = FORCED_TEST_SUITE_TIMEOUT_MS,
	env = process.env,
	log = (line) => console.log(line),
} = {}) {
	const rootDirectory = process.cwd();
	const steps = plan ?? planForcedTestSuite({ rootDirectory, workspaces: await resolveWorkspaceDirectories(rootDirectory) });
	const startedAt = Date.now();
	const remaining = () => timeoutMs - (Date.now() - startedAt);
	const results = [];
	const record = (result) => {
		log(`[forced-tests] ${result.step.label}: ${verdictOf(result)}`);
		results.push(result);
	};
	const stopAtBudget = () => {
		const running = results.filter((result) => result.timedOut);
		if (running.length === 0) return;
		throw new Error(
			`the forced test suite ran out of its ${timeoutMs / 60_000} min budget after ${minutes(Date.now() - startedAt)} min: ` +
				`${running.map((result) => `${result.step.label} was still running after ${minutes(result.elapsedMs)} min`).join("; ")}. ` +
				"The [forced-tests] wall lines above show whether one step stalled or the suite outgrew the budget (senpi#6139)",
		);
	};

	for (const step of steps.serial) {
		record(await runStep(step, remaining(), env));
		stopAtBudget();
	}
	const shardsStartedAt = Date.now();
	for (const result of await Promise.all(steps.parallel.map((step) => runStep(step, remaining(), env)))) record(result);
	log(
		`[forced-tests] total wall ${minutes(Date.now() - startedAt)} min of the ${timeoutMs / 60_000} min budget; ` +
			`${steps.parallel.length} parallel step(s) took ${minutes(Date.now() - shardsStartedAt)} min`,
	);
	stopAtBudget();
	const failed = results.filter((result) => result.error || result.status !== 0);
	if (failed.length > 0) {
		const named = failed.map((result) => `${result.step.label} (${result.error ? result.error.message : `exit ${result.status}`})`);
		throw new Error(`the forced test suite failed: ${named.join(", ")}`);
	}
}
