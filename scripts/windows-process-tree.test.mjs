#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsProcessCreatedAtAsync, windowsTreeKillArgs } from "./windows-process-tree.mjs";

const argsFor = (rows, selfPid = 900) => windowsTreeKillArgs(100, () => ({ status: 0, stdout: rows }), selfPid);

test("a recycled root or intermediate parent cannot adopt older unrelated processes", () => {
	const rows = [
		"104 101 220 child.exe",
		"102 100 50 unrelated.exe",
		"103 101 150 unrelated.exe",
		"101 100 210 node.exe",
		"100 1 200 bun.exe",
	].join("\n");
	assert.deepEqual(argsFor(rows), ["/F", "/PID", "100", "/PID", "101", "/PID", "104"]);
});

test("unknown creation times cannot prove descendant membership", () => {
	assert.deepEqual(argsFor("100 1 200 bun.exe\n101 100 0 child.exe"), ["/F", "/PID", "100"]);
	assert.deepEqual(argsFor("100 1 0 bun.exe\n101 100 210 child.exe"), ["/F", "/PID", "100"]);
});

test("a protected descendant or own ancestor refuses the tree", () => {
	assert.deepEqual(argsFor("100 1 200 bun.exe\n101 100 210 svchost.exe"), ["/F", "/PID", "100"]);
	assert.deepEqual(argsFor("100 1 200 bun.exe\n101 100 210 node.exe\n900 101 220 test.exe"), []);
	assert.deepEqual(argsFor("100 1 200 svchost.exe"), []);
});

test("a missing root is not killed and listing failure never delegates an unchecked tree", () => {
	assert.deepEqual(argsFor("101 1 210 child.exe"), []);
	for (const result of [{ status: 1 }, { status: 0, stdout: "bad output" }, { status: null, error: new Error("unavailable") }]) {
		assert.deepEqual(windowsTreeKillArgs(100, () => result), ["/F", "/PID", "100"]);
	}
});

test("invalid or own root PIDs never execute a process probe", () => {
	for (const pid of [0, -1, Number.NaN, process.pid]) {
		assert.deepEqual(windowsTreeKillArgs(pid, () => assert.fail("unexpected probe")), []);
	}
});

const identified = (rows) => windowsTreeKillArgs(100, () => ({ status: 0, stdout: rows }), 900, 200n);

test("with a recorded root identity the root is never listed and its descendants survive its exit", () => {
	const ours = "100 1 200 bun.exe\n101 100 210 node.exe\n104 101 220 child.exe";
	assert.deepEqual(identified(ours), ["/F", "/PID", "101", "/PID", "104"]);
	assert.deepEqual(identified("101 100 210 node.exe\n104 101 220 child.exe"), ["/F", "/PID", "101", "/PID", "104"]);
});

test("with a recorded root identity a stranger on the reused PID and its children are skipped", () => {
	const reused = "100 1 300 stranger.exe\n105 100 310 stranger-child.exe\n101 100 210 node.exe";
	assert.deepEqual(identified(reused), ["/F", "/PID", "101"]);
	assert.deepEqual(windowsTreeKillArgs(100, () => ({ error: new Error("no listing") }), 900, 200n), []);
});

test("the creation-time reader accepts only a positive FILETIME", async () => {
	const reading = (out, error = null) => windowsProcessCreatedAtAsync(100, (_file, _args, _options, cb) => cb(error, out));
	assert.equal(await reading("133000000000000000\r\n"), 133000000000000000n);
	assert.equal(await reading(""), undefined);
	assert.equal(await reading("0"), undefined);
	assert.equal(await reading("x", new Error("denied")), undefined);
});
