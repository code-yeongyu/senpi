import assert from "node:assert/strict";
import test from "node:test";
import { capitalize, reverse } from "../src/strings.mjs";

test("capitalize upper-cases the first letter", () => {
	assert.equal(capitalize("senpi"), "Senpi");
});

test("reverse reverses the characters", () => {
	assert.equal(reverse("abc"), "cba");
});
