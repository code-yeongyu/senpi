#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGrepBenchGate } from "./bench-grep.mjs";

function syntheticReport({ smallRatio, mediumRatio, smallNativeMatches = 10, smallRgMatches = 10 }) {
	return {
		cases: [
			{
				id: "small-dir",
				mode: "content",
				native: { sequentialMinMs: 1, matches: smallNativeMatches },
				rg: { sequentialMinMs: smallRatio, matches: smallRgMatches },
			},
			{
				id: "medium-maxCount-100",
				mode: "content",
				maxCount: 100,
				native: { sequentialMinMs: 1, matches: 100 },
				rg: { sequentialMinMs: mediumRatio, matches: 100 },
			},
		],
	};
}

test("ratio 1.0 fails the gate naming the slow cases", () => {
	const result = evaluateGrepBenchGate(syntheticReport({ smallRatio: 1.0, mediumRatio: 1.0 }));
	assert.equal(result.ok, false);
	assert.ok(
		result.failures.some((failure) => failure.includes("small-dir")),
		`expected small-dir in ${JSON.stringify(result.failures)}`,
	);
	assert.ok(
		result.failures.some((failure) => failure.includes("medium-maxCount-100")),
		`expected medium-maxCount-100 in ${JSON.stringify(result.failures)}`,
	);
});

test("ratio 2.5 passes the sequential speedup gate", () => {
	const result = evaluateGrepBenchGate(syntheticReport({ smallRatio: 2.5, mediumRatio: 2.5 }));
	assert.equal(result.ok, true);
	assert.deepEqual(result.failures, []);
});
