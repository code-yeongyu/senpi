import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OwnedSignalRefusedError, signalOwnedProcess } from "./owned-signal.mjs";

// A fake process table: `inspect` answers ppid / pgid / command / cwd, `kill` records instead of signalling.
function table(rows) {
	const sent = [];
	return {
		sent,
		inspect: (pid) => rows[pid],
		kill: (pid, signal) => {
			sent.push([pid, signal]);
		},
	};
}
const SELF = process.pid;

test("refuses a pid that neither descends from the driver nor was returned by its tool", () => {
	const t = table({ 4242: { ppid: 1, pgid: 4242, command: "node host --socket /tmp/other/h.sock", cwd: "/" } });
	assert.throws(() => signalOwnedProcess({ pid: 4242, signal: "SIGKILL", sandboxPath: "/tmp/other", ...t }), OwnedSignalRefusedError);
	assert.deepEqual(t.sent, []);
});

test("refuses a returned pid whose command line and cwd lack the sandbox path", () => {
	const t = table({ 4242: { ppid: 1, pgid: 4242, command: "node host --socket /tmp/foreign/h.sock", cwd: "/tmp/foreign" } });
	assert.throws(
		() => signalOwnedProcess({ pid: 4242, returned: true, signal: "SIGKILL", sandboxPath: "/sandbox/abc", ...t }),
		OwnedSignalRefusedError,
	);
	assert.throws(() => signalOwnedProcess({ pid: 4242, returned: true, signal: "SIGKILL", ...t }), OwnedSignalRefusedError);
	assert.deepEqual(t.sent, []);
});

test("refuses a target whose identity does not match", () => {
	const t = table({ 4242: { ppid: 1, pgid: 4242, command: "node other --socket /sandbox/abc/h.sock", cwd: "/" } });
	assert.throws(
		() =>
			signalOwnedProcess({ pid: 4242, returned: true, sandboxPath: "/sandbox/abc", expectCommand: "host-lifecycle", ...t }),
		OwnedSignalRefusedError,
	);
	assert.deepEqual(t.sent, []);
});

test("refuses pid <= 1, itself, and a group signal without a spawned handle", () => {
	const t = table({ 4242: { ppid: SELF, pgid: 4242, command: "node /sandbox/abc/x", cwd: "/" } });
	for (const pid of [0, 1, -4242, SELF, Number.NaN])
		assert.throws(() => signalOwnedProcess({ pid, returned: true, sandboxPath: "/sandbox/abc", ...t }), OwnedSignalRefusedError);
	assert.throws(() => signalOwnedProcess({ pid: 4242, group: true, sandboxPath: "/sandbox/abc", ...t }), OwnedSignalRefusedError);
	assert.deepEqual(t.sent, []);
});

test("signals a descendant or a returned pid once its sandbox path and identity match", () => {
	const t = table({
		4242: { ppid: 4100, pgid: 4242, command: "node host-lifecycle --socket /sandbox/abc/h.sock", cwd: "/" },
		4100: { ppid: SELF, pgid: 4100, command: "node driver", cwd: "/" },
		4343: { ppid: 1, pgid: 4343, command: "node host-lifecycle", cwd: "/sandbox/abc/work" },
	});
	assert.equal(signalOwnedProcess({ pid: 4242, signal: "SIGTERM", sandboxPath: "/sandbox/abc", ...t }), true);
	assert.equal(
		signalOwnedProcess({ pid: 4343, returned: true, signal: "SIGKILL", sandboxPath: "/sandbox/abc", expectCommand: "host-lifecycle", ...t }),
		true,
	);
	assert.deepEqual(t.sent, [
		[4242, "SIGTERM"],
		[4343, "SIGKILL"],
	]);
});

test("a gone target is not an error and is not signalled", () => {
	const t = table({});
	assert.equal(signalOwnedProcess({ pid: 4242, returned: true, sandboxPath: "/sandbox/abc", ...t }), false);
	assert.deepEqual(t.sent, []);
});

test("signals a real spawned child, and a real returned process through the live process table", { skip: process.platform === "win32" }, async (t) => {
	const sandbox = mkdtempSync(join(tmpdir(), "owned-signal-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const spawned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
	await once(spawned, "spawn");
	const spawnedExit = once(spawned, "exit");
	assert.equal(signalOwnedProcess({ pid: spawned.pid, spawned, signal: "SIGTERM" }), true);
	assert.deepEqual(await spawnedExit, [null, "SIGTERM"]);
	assert.equal(signalOwnedProcess({ pid: spawned.pid, spawned, signal: "SIGTERM" }), false);

	const returned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", join(sandbox, "h.sock")], { stdio: "ignore" });
	await once(returned, "spawn");
	const returnedExit = once(returned, "exit");
	assert.equal(signalOwnedProcess({ pid: returned.pid, returned: true, sandboxPath: sandbox, signal: "SIGKILL" }), true);
	assert.deepEqual(await returnedExit, [null, "SIGKILL"]);
});
