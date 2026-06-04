#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { run } from "./local-release.mjs";

let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("local-release command runner", () => {
	it("captures large npm pack JSON output", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-local-release-pack-"));
		const scriptPath = join(tempDir, "large-pack-output.mjs");
		writeFileSync(
			scriptPath,
			[
				"const largeFiles = Array.from({ length: 30_000 }, (_, index) => ({",
				"  path: `node_modules/package-${index}/index.js`,",
				"  size: 42,",
				"}));",
				"process.stdout.write(JSON.stringify([{ filename: 'large.tgz', files: largeFiles }]));",
				"",
			].join("\n"),
		);

		// When
		const output = run(process.execPath, [scriptPath], { capture: true });

		// Then
		const packed = JSON.parse(output)[0];
		assert.equal(packed.filename, "large.tgz");
		assert.equal(packed.files.length, 30_000);
	});
});

describe("Bun binary entry", () => {
	it("routes directly to the full CLI instead of the Node wrapper", () => {
		// Given
		const entrySource = readFileSync(join(process.cwd(), "packages/coding-agent/src/bun/cli.ts"), "utf8");

		// Then
		assert.match(entrySource, /import\(["']\.\.\/cli-main\.ts["']\)/);
		assert.doesNotMatch(entrySource, /import\(["']\.\.\/cli\.ts["']\)/);
	});
});
