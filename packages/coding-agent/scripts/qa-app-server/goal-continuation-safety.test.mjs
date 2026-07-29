import assert from "node:assert/strict";
import { test } from "vitest";
import { runLauncher } from "./goal-continuation-safety.mjs";

function runWithFakeProbe({ status = 0, remove } = {}) {
	const files = new Set();
	const reports = [];
	const result = runLauncher({
		platformName: "darwin",
		sandboxExecPath: "/fake/sandbox-exec",
		exists: () => true,
		getHomeDirectory: () => "/qa/home",
		getTempDirectory: () => "/qa/tmp",
		makeUuid: () => "unit-test",
		realpath: (path) => path,
		write: (path) => files.add(path),
		remove:
			remove ??
			((path) => {
				if (!files.delete(path)) throw new Error(`missing temporary probe ${path}`);
			}),
		spawn: () => ({ status }),
		report: (message) => reports.push(message),
	});
	return { files, reports, result };
}

test("Seatbelt launcher removes its temp probe after a successful probe", () => {
	const { files, reports, result } = runWithFakeProbe();

	assert.equal(result.exitCode, 0);
	assert.equal(result.cleanupError, undefined);
	assert.deepEqual([...files], []);
	assert.deepEqual(reports, []);
});

test("Seatbelt launcher removes its temp probe after a fail-closed preflight exit", () => {
	const { files, reports, result } = runWithFakeProbe({ status: 1 });

	assert.equal(result.exitCode, 1);
	assert.equal(result.cleanupError, undefined);
	assert.deepEqual([...files], []);
	assert.deepEqual(reports, []);
});

test("Seatbelt launcher records a temp-probe cleanup failure and fails closed", () => {
	const cleanupFailure = new Error("read-only temp directory");
	const { reports, result } = runWithFakeProbe({ remove: () => {
		throw cleanupFailure;
	} });

	assert.equal(result.exitCode, 1);
	assert.equal(result.cleanupError, cleanupFailure);
	assert.deepEqual(reports, [
		"LAUNCHER CLEANUP ERROR: failed to remove /qa/tmp/senpi-qa-probe-write-test-unit-test.txt: read-only temp directory",
	]);
});
