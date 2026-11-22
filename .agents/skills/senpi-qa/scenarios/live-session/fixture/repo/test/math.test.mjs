import assert from "node:assert/strict";
import test from "node:test";
import { mean, sum } from "../src/math.mjs";

test("sum adds every value", () => {
	assert.equal(sum([1, 2, 3]), 6);
});

test("mean is the sum over the count", () => {
	assert.equal(mean([2, 4, 6]), 4);
});
