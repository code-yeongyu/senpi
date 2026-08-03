#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = join(root, "scripts", "check-ts-relative-imports.mjs");

describe("check-ts-relative-imports", () => {
	it("passes when all relative .ts imports use .ts specifiers", (t) => {
		// Given
		const fixture = mkdtempSync(join(tmpdir(), "check-ts-imports-"));
		t.after(() => rmSync(fixture, { recursive: true, force: true }));
		const cleanDir = join(fixture, "clean");
		mkdirSync(cleanDir, { recursive: true });
		writeFileSync(join(cleanDir, "ok.ts"), `import { x } from "./other.ts";\n`);

		// When
		const result = spawnSync("node", [checker], {
			cwd: cleanDir,
			timeout: 10000,
			encoding: "utf8",
		});

		// Then
		assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	});

	it("fails when a .ts file uses a relative .js specifier", (t) => {
		// Given
		const fixture = mkdtempSync(join(tmpdir(), "check-ts-imports-"));
		t.after(() => rmSync(fixture, { recursive: true, force: true }));
		const badDir = join(fixture, "bad");
		mkdirSync(badDir, { recursive: true });
		writeFileSync(join(badDir, "violation.ts"), `import { y } from "./other.js";\n`);

		// When
		const result = spawnSync("node", [checker], {
			cwd: badDir,
			timeout: 10000,
			encoding: "utf8",
		});

		// Then
		assert.notEqual(result.status, 0, `expected non-zero exit, got status ${result.status}`);
		const combined = `${result.stdout}\n${result.stderr}`;
		assert.match(combined, /violation\.ts/, `expected violation.ts in output, got: ${combined}`);
	});
});
