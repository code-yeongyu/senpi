import assert from "node:assert/strict";
import test from "node:test";
import { applyPostExitCleanup, sendSigkillTree, teardownPty, waitForPtyExit } from "./tui-resume-teardown.mjs";

function fakeTerm(pid = 4242) {
	const calls = [];
	return {
		pid,
		calls,
		write(data) {
			calls.push(["write", data]);
		},
		kill(signal) {
			calls.push(["kill", signal]);
		},
	};
}

function pendingStream() {
	let resolveExit;
	const stream = {
		exit: null,
		exitPromise: new Promise((resolve) => {
			resolveExit = resolve;
		}),
		resolve(event) {
			stream.exit = event;
			resolveExit(event);
		},
	};
	return stream;
}

test("waitForPtyExit unschedules the timer when the PTY already exited", async () => {
	let cleared = false;
	const result = await waitForPtyExit(Promise.resolve({ exitCode: 0, signal: null }), 9999, {
		schedule: () => 1,
		unschedule: () => {
			cleared = true;
		},
	});
	assert.deepEqual(result, { event: { exitCode: 0, signal: null } });
	assert.equal(cleared, true);
});

test("sendSigkillTree sends process-group SIGKILL on POSIX", () => {
	const term = fakeTerm(4242);
	const kills = [];
	sendSigkillTree({
		pid: 4242,
		term,
		platform: "darwin",
		killProcess(pid, signal) {
			kills.push([pid, signal]);
		},
	});
	assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
	assert.deepEqual(term.calls, [["kill", "SIGKILL"]]);
});

test("teardownPty escalates to process-group SIGKILL after graceful timeout", async () => {
	const term = fakeTerm(4242);
	const stream = pendingStream();
	const kills = [];
	let waits = 0;
	const receipt = await teardownPty(term, stream, {
		platform: "darwin",
		killProcess(pid, signal) {
			kills.push([pid, signal]);
			stream.resolve({ exitCode: null, signal: 9 });
		},
		async waitExit() {
			waits += 1;
			if (waits === 1) return { timeout: true };
			return { event: stream.exit };
		},
	});
	assert.equal(receipt.escalated, true);
	assert.equal(receipt.ptyExited, true);
	assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
	assert.equal(
		term.calls.some((call) => call[0] === "kill" && call[1] === "SIGKILL"),
		true,
	);
});

test("teardownPty throws when exit cannot be confirmed", async () => {
	const term = fakeTerm(7);
	const stream = pendingStream();
	await assert.rejects(
		() =>
			teardownPty(term, stream, {
				platform: "darwin",
				killProcess() {},
				async waitExit() {
					return { timeout: true };
				},
			}),
		/exit not confirmed/,
	);
});

test("applyPostExitCleanup does not remove the sandbox when PTY is still alive", () => {
	let removed = false;
	const receipt = applyPostExitCleanup(
		{ ptyExited: false },
		{
			removeSandbox() {
				removed = true;
			},
			sandboxExists() {
				return true;
			},
			assertAuth() {
				return true;
			},
		},
	);
	assert.equal(removed, false);
	assert.equal(receipt.sandboxRemoved, false);
	assert.equal(receipt.cleanupSequence.includes("sandboxRemoved"), false);
});

test("applyPostExitCleanup records ptyExited before sandboxRemoved and authUnchanged", () => {
	const receipt = applyPostExitCleanup(
		{ ptyExited: true },
		{
			removeSandbox() {},
			sandboxExists() {
				return false;
			},
			assertAuth() {
				return true;
			},
		},
	);
	assert.deepEqual(receipt.cleanupSequence, ["ptyExited", "sandboxRemoved", "authUnchanged"]);
	assert.ok(receipt.cleanupSequence.indexOf("ptyExited") < receipt.cleanupSequence.indexOf("sandboxRemoved"));
	assert.ok(receipt.cleanupSequence.indexOf("ptyExited") < receipt.cleanupSequence.indexOf("authUnchanged"));
});
