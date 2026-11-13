#!/usr/bin/env node
// Two-lane execution for `run-workspaces.mjs --alongside <workspace>`.
//
// The root `test` script used to run every workspace test suite one after
// another. One workspace (coding-agent) holds most of the suite's wall time,
// and while its own worker pool drains, the machine has idle cores the other
// workspaces could use. `--alongside` runs that one workspace in its own lane
// and every other selected workspace, still one at a time in path order, in a
// second lane at the same time.
//
// The second lane only starts when the machine has room for it. The alongside
// workspace's Vitest pool already takes `availableParallelism() - 1` workers
// (Vitest's default), so a second lane always oversubscribes the CPU a little;
// below MIN_PARALLELISM_FOR_SECOND_LANE that oversubscription turns into test
// timeouts, so the run stays fully sequential there, exactly as without the
// flag. RUN_WORKSPACES_PARALLELISM overrides the detected count, for containers
// whose CPU quota `availableParallelism()` does not see.

import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { createSignalFanout, spawnPackageManager } from "./package-manager.mjs";

export const MIN_PARALLELISM_FOR_SECOND_LANE = 8;

/** The parallelism the lane decision uses: the override when it is a positive integer, else the machine's. */
export function detectParallelism(env = process.env, detect = availableParallelism) {
	const override = env.RUN_WORKSPACES_PARALLELISM;
	if (override !== undefined && override !== "") {
		const parsed = Number(override);
		if (!Number.isInteger(parsed) || parsed < 1) {
			throw new RangeError(`RUN_WORKSPACES_PARALLELISM must be a positive integer, got "${override}"`);
		}
		return parsed;
	}
	return detect();
}

export function secondLaneFits(parallelism) {
	return parallelism >= MIN_PARALLELISM_FOR_SECOND_LANE;
}

/**
 * Runs `alongside` in one lane and `rest` sequentially in a second lane, both at
 * once. Every output line carries its workspace directory name. One shared
 * signal fan-out reaches whichever children are running; after a signal the
 * second lane starts no further workspace, and the signal is re-raised once
 * both lanes have closed. Resolves with one exit status per workspace, keyed by
 * workspace object.
 */
export async function runAlongside(pm, pmArgs, alongside, rest, { env, label }) {
	const fanout = createSignalFanout();
	const statuses = new Map();
	const spawnLane = (workspace) => {
		console.log(`[${label}] > ${workspace.relativePath} (${workspace.name}): ${pm.cmd} ${pmArgs.join(" ")}`);
		return spawnPackageManager(pm, pmArgs, {
			cwd: workspace.directory,
			env,
			label,
			prefix: basename(workspace.directory),
			fanout,
		});
	};
	const sequentialLane = async () => {
		for (const workspace of rest) {
			if (fanout.signalled()) break;
			statuses.set(workspace, await spawnLane(workspace));
		}
	};
	try {
		await Promise.all([
			spawnLane(alongside).then((status) => statuses.set(alongside, status)),
			sequentialLane(),
		]);
		return statuses;
	} finally {
		const forwarded = await fanout.release();
		if (forwarded) process.kill(process.pid, forwarded);
	}
}
