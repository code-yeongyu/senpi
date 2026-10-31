import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureOutput } from "./release-capture.mjs";

describe("captureOutput", () => {
	it("returns output larger than execFileSync's 1 MiB default buffer (a CHANGELOG.md read through git show)", () => {
		const size = 3 * 1024 * 1024;
		const output = captureOutput(process.execPath, ["-e", `process.stdout.write("x".repeat(${size}))`]);
		assert.equal(output.length, size);
	});
});
