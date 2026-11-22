#!/usr/bin/env node
/**
 * Runs one step of the release's forced test suite as the leader of its own process group and, when the budget
 * runs out, SIGKILLs that group and exits, so a hung step cannot hold the release past its budget (senpi#2291).
 * The kill reaches only processes still in that group: run-workspaces (package-manager.mjs) and run-tests.mjs spawn
 * npm and vitest detached, in groups of their own, so a hung vitest worker can outlive it (senpi#6141).
 * `release-forced-test-suite.mjs` `runForcedTestSuite` runs one per step (the coding-agent shards at once) and maps
 * exit 124 to the timeout error naming that step.
 *
 * Usage: node release-forced-test-supervisor.mjs <timeoutMs> <bin> [args...]
 */
import { spawn } from "node:child_process";

export const SUPERVISOR_TIMEOUT_EXIT = 124;

const [timeoutArg, bin, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
if (!bin || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
	process.stderr.write("usage: release-forced-test-supervisor.mjs <timeoutMs> <bin> [args...]\n");
	process.exit(2);
}

const child = spawn(bin, args, { stdio: "inherit", detached: true });
const killGroup = () => {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// The group is already gone.
	}
};
const timer = setTimeout(() => {
	killGroup();
	process.exit(SUPERVISOR_TIMEOUT_EXIT);
}, timeoutMs);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		killGroup();
		process.exit(1);
	});
}
child.on("error", (err) => {
	clearTimeout(timer);
	process.stderr.write(`${bin} could not start: ${err.message}\n`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	clearTimeout(timer);
	killGroup();
	process.exit(code ?? (signal ? 1 : 0));
});
