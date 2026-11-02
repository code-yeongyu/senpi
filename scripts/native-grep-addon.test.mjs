import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNativeGrepAddon } from "./native-grep-addon.mjs";

// #3978: in CI the probe tests never build the addon inside a test hook.
test("in CI without SENPI_GREP_NATIVE_PATH or a local addon, the resolver refuses with the missing step named", () => {
	const result = resolveNativeGrepAddon({ env: { CI: "true" }, localAddon: undefined });
	assert.equal(result.kind, "missing-in-ci");
	assert.match(result.message, /SENPI_GREP_NATIVE_PATH/);
	assert.match(result.message, /Build native grep addon/);
});

test("an exported path always wins, in CI or not", () => {
	assert.deepEqual(resolveNativeGrepAddon({ env: { CI: "true", SENPI_GREP_NATIVE_PATH: "/x/a.node" }, localAddon: undefined }), {
		kind: "path",
		path: "/x/a.node",
	});
});

test("a local addon is used without building", () => {
	assert.deepEqual(resolveNativeGrepAddon({ env: { CI: "true" }, localAddon: "senpi_grep.linux-x64-gnu.node" }), {
		kind: "local",
		file: "senpi_grep.linux-x64-gnu.node",
	});
});

test("outside CI with nothing built, the test may build in place", () => {
	assert.deepEqual(resolveNativeGrepAddon({ env: {}, localAddon: undefined }), { kind: "build" });
});
