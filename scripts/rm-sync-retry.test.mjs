#!/usr/bin/env node

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmSyncRetry } from "./rm-sync-retry.mjs";

function locked(code = "EBUSY") {
	return Object.assign(new Error(`${code}: resource busy or locked, rm 'scratch'`), { code });
}

function clock() {
	let t = 0;
	const sleeps = [];
	return {
		now: () => t,
		sleep: (ms) => {
			sleeps.push(ms);
			t += ms;
		},
		sleeps,
	};
}

describe("rmSyncRetry", () => {
	it("removes the directory on the first try", () => {
		// Given
		const removed = [];
		// When
		const result = rmSyncRetry("scratch", { rmSync: (path) => removed.push(path) });
		// Then
		assert.deepEqual(result, { removed: true });
		assert.deepEqual(removed, ["scratch"]);
	});

	it("retries a Windows hold (EBUSY, then EPERM) until the delete succeeds", () => {
		// Given
		const time = clock();
		const errors = [locked("EBUSY"), locked("EPERM")];
		let calls = 0;
		// When
		const result = rmSyncRetry("scratch", {
			rmSync: () => {
				calls += 1;
				const error = errors.shift();
				if (error) throw error;
			},
			now: time.now,
			sleep: time.sleep,
			deadlineMs: 1_000,
			backoffMs: 10,
		});
		// Then
		assert.deepEqual(result, { removed: true });
		assert.equal(calls, 3);
		assert.deepEqual(time.sleeps, [10, 20]);
	});

	it("reports a directory still held at the deadline instead of throwing", () => {
		// Given
		const time = clock();
		const held = locked("EBUSY");
		// When
		const result = rmSyncRetry("scratch", {
			rmSync: () => {
				throw held;
			},
			now: time.now,
			sleep: time.sleep,
			deadlineMs: 100,
			backoffMs: 10,
		});
		// Then
		assert.equal(result.removed, false);
		assert.equal(result.error, held);
		assert.ok(time.sleeps.reduce((total, ms) => total + ms, 0) >= 100);
	});

	it("throws an error that is not a transient Windows hold", () => {
		// Given
		const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		let calls = 0;
		// When / Then
		assert.throws(
			() =>
				rmSyncRetry("scratch", {
					rmSync: () => {
						calls += 1;
						throw denied;
					},
				}),
			(error) => error === denied,
		);
		assert.equal(calls, 1);
	});
});
