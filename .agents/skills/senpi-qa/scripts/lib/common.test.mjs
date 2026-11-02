import assert from "node:assert/strict";
import test from "node:test";
import { evidenceDir } from "./common.mjs";

test("evidenceDir accepts one safe path segment", () => {
	const dir = evidenceDir("dollar-invocation-safe");
	assert.match(dir, /local-ignore\/qa-evidence\/\d{8}-dollar-invocation-safe$/);
});

test("evidenceDir rejects path traversal and nested paths", () => {
	for (const slug of ["../escape", "nested/path", "nested\\path", ".", "..", ""]) {
		assert.throws(() => evidenceDir(slug), /single safe path segment/);
	}
});
