import assert from "node:assert/strict";
import test from "node:test";
import { chunk, unique } from "../src/list.mjs";

test("chunk splits into groups of size", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("unique keeps the first occurrence of each item", () => {
	assert.deepEqual(unique([1, 2, 1, 3, 2]), [1, 2, 3]);
});
