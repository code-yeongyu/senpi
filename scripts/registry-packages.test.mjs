import assert from "node:assert/strict";
import test from "node:test";
import {
	registrySourcePackageNames,
	resolveRegistryPackages,
} from "./registry-packages.mjs";

const completeSources = [...registrySourcePackageNames].map((name) => ({ name }));

test("resolves every registry package source exactly once", () => {
	assert.equal(resolveRegistryPackages(completeSources).length, 7);
});

test("rejects a missing registry package source", () => {
	assert.throws(
		() => resolveRegistryPackages(completeSources.slice(1)),
		/Missing registry package sources/,
	);
});

test("rejects a duplicate registry package source", () => {
	assert.throws(
		() => resolveRegistryPackages([...completeSources, completeSources[0]]),
		/Duplicate registry package source/,
	);
});
