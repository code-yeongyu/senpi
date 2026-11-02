#!/usr/bin/env node

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RenameSyncRetryError, renameSyncRetry } from "./rename-sync-retry.mjs";

function eperm(message = "EPERM: operation not permitted, rename") {
	return Object.assign(new Error(message), { code: "EPERM" });
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

describe("renameSyncRetry", () => {
	it("retries EPERM twice then keeps the successful rename", () => {
		// Given
		const time = clock();
		let calls = 0;
		const seen = [];
		const first = eperm();
		const second = eperm();
		// When
		renameSyncRetry("from", "to", {
			renameSync: (oldPath, newPath) => {
				seen.push([oldPath, newPath]);
				calls += 1;
				if (calls === 1) throw first;
				if (calls === 2) throw second;
			},
			now: time.now,
			sleep: time.sleep,
			deadlineMs: 1_000,
			backoffMs: 10,
		});
		// Then
		assert.equal(calls, 3);
		assert.deepEqual(seen, [
			["from", "to"],
			["from", "to"],
			["from", "to"],
		]);
		assert.deepEqual(time.sleeps, [10, 20]);
	});

	it("fails loudly with the original EPERM attached when the deadline expires", () => {
		// Given
		const time = clock();
		const original = eperm("EPERM: operation not permitted, rename 'from' -> 'to'");
		let calls = 0;
		// When
		let thrown;
		try {
			renameSyncRetry("from", "to", {
				renameSync: () => {
					calls += 1;
					throw original;
				},
				now: time.now,
				sleep: time.sleep,
				deadlineMs: 50,
				backoffMs: 10,
			});
		} catch (error) {
			thrown = error;
		}
		// Then
		assert.ok(thrown instanceof RenameSyncRetryError);
		assert.equal(thrown.cause, original);
		assert.equal(thrown.code, "EPERM");
		assert.match(thrown.message, /rename 'from' -> 'to' failed after 50ms/);
		assert.match(thrown.message, /EPERM: operation not permitted/);
		assert.ok(calls >= 2);
		assert.ok(time.now() >= 50);
	});

	it("throws a non-transient errno immediately without sleeping", () => {
		// Given
		const time = clock();
		const missing = Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" });
		// When
		assert.throws(
			() =>
				renameSyncRetry("from", "to", {
					renameSync: () => {
						throw missing;
					},
					now: time.now,
					sleep: time.sleep,
					deadlineMs: 1_000,
				}),
			(error) => error === missing,
		);
		// Then
		assert.deepEqual(time.sleeps, []);
		assert.equal(time.now(), 0);
	});
});
