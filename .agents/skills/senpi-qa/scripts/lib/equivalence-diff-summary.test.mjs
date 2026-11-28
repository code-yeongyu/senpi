import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDiffs } from "./equivalence-diff-summary.mjs";

test("the console reports how much of the full mismatch set it omitted (#5262)", () => {
	const row = { path: "$.field", golden: "x".repeat(158), actual: "y".repeat(159) };
	const rows = Array(13).fill(row);
	const lines = summarizeDiffs(rows);
	assert.equal(lines[0], `    $.field: golden=${JSON.stringify(row.golden)} actual=${JSON.stringify(row.actual).slice(0, 160)}…(+1 char)`);
	assert.equal(lines.length, 13);
	assert.equal(lines[12], "    …(+1 more row)");
	assert.equal(summarizeDiffs(rows.slice(0, 12)).length, 12);
	assert.deepEqual(summarizeDiffs([{ path: "$.missing", golden: undefined, actual: 0 }]), [
		"    $.missing: golden=undefined actual=0",
	]);
});
