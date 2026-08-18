import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

const scriptPath = resolve("scripts/copy-codemode-sidecar.mjs");
let outputRoot;

afterEach(() => {
	if (outputRoot) {
		rmSync(outputRoot, { recursive: true, force: true });
		outputRoot = undefined;
	}
});

function runCopier() {
	outputRoot = mkdtempSync(join(tmpdir(), "senpi-codemode-sidecar-"));
	return spawnSync(process.execPath, [scriptPath, outputRoot], {
		cwd: resolve("."),
		encoding: "utf8",
	});
}

describe("copy-codemode-sidecar", () => {
	it("copies the source-only runtime payload into the binary node_modules layout", () => {
		const result = runCopier();
		const target = join(outputRoot, "node_modules", "@code-yeongyu", "senpi-codemode");

		assert.equal(result.status, 0, result.stderr);
		for (const path of [
			"package.json",
			"README.md",
			"CHANGELOG.md",
			"LICENSE",
			"src/index.ts",
			"src/kernels/js/worker-entry.js",
			"src/kernels/js/inline-worker-entry.js",
			"src/kernels/py/prelude.py",
			"src/kernels/rb/runner.rb",
			"src/kernels/jl/runner.jl",
		]) {
			assert.equal(existsSync(join(target, path)), true, `missing copied runtime file: ${path}`);
		}
		assert.equal(existsSync(join(target, "test")), false);
		assert.equal(existsSync(join(target, "node_modules")), false);
	});

	it("replaces stale sidecar contents instead of merging them", () => {
		outputRoot = mkdtempSync(join(tmpdir(), "senpi-codemode-sidecar-"));
		const target = join(outputRoot, "node_modules", "@code-yeongyu", "senpi-codemode");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "stale.txt"), "stale");

		const result = spawnSync(process.execPath, [scriptPath, outputRoot], {
			cwd: resolve("."),
			encoding: "utf8",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(target, "stale.txt")), false);
		assert.equal(existsSync(join(target, "src", "index.ts")), true);
	});
});
