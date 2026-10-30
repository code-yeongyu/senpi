/**
 * The fixture-cleanup helper for a DETACHED fixture that by contract survived the tool child: the
 * test's own fixture removes it. It must find the fixture alive (a fixture already gone means it was
 * wrongly swept, `fixture_already_gone`), kills it by process group on POSIX (`TERM`, then `KILL`) or
 * with a creation-time-checked explicit PID list on Windows, confirms it is gone within a bounded budget, and records
 * `fixture_cleanup{launchId, pid, method, gone:true}`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QaFailure } from "./qa-failure.mjs";
import { windowsTreeKillArgs } from "../../../../../scripts/windows-process-tree.mjs";

const run = promisify(execFile);

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function signalGroup(pgid, signal) {
	try {
		process.kill(-pgid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

/** Bounded liveness confirmation for a process that is not our child (no exit event exists for it). */
async function goneWithin(pid, isAlive, budgetMs) {
	const deadline = Date.now() + budgetMs;
	while (isAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

export async function cleanupDetachedFixture(
	{ launchId, pid, pgid },
	{ record, platform = process.platform, isAlive = processAlive, budgetMs = 3_000 } = {},
) {
	if (!isAlive(pid)) {
		throw new QaFailure("fixture_already_gone", `detached fixture ${pid} (${launchId}) was gone before cleanup`);
	}
	let method;
	if (platform === "win32") {
		method = "taskkill /F explicit PIDs";
		const args = windowsTreeKillArgs(pid);
		if (args.length > 0) await run("taskkill", args, { windowsHide: true });
	} else {
		method = "kill -TERM -pgid";
		signalGroup(pgid ?? pid, "SIGTERM");
		if (!(await goneWithin(pid, isAlive, budgetMs))) {
			method = "kill -KILL -pgid";
			signalGroup(pgid ?? pid, "SIGKILL");
		}
	}
	if (!(await goneWithin(pid, isAlive, budgetMs))) {
		throw new QaFailure("fixture_cleanup_failed", `detached fixture ${pid} (${launchId}) survived ${method}`);
	}
	const entry = { type: "fixture_cleanup", launchId, pid, method, gone: true };
	record?.(entry);
	return entry;
}
