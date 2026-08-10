#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { computeNextVersion } from "./calver.mjs";

let tempDir;
let previousPath;

afterEach(() => {
	if (previousPath !== undefined) {
		process.env.PATH = previousPath;
		previousPath = undefined;
	}
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("computeNextVersion", () => {
	it("stays above a future-dated published version", () => {
		installFakeVersionSources(["2026.8.11"]);

		const version = computeNextVersion({
			date: "2026.8.10",
			packages: ["@example/senpi"],
		});

		assert.equal(version, "2026.8.11-2");
	});

	it("increments the highest suffix for the current date", () => {
		installFakeVersionSources(["2026.8.10", "2026.8.10-3"]);

		const version = computeNextVersion({
			date: "2026.8.10",
			packages: ["@example/senpi"],
		});

		assert.equal(version, "2026.8.10-4");
	});

	it("uses a later current date without carrying an old suffix forward", () => {
		installFakeVersionSources(["2026.8.11-3"]);

		const version = computeNextVersion({
			date: "2026.8.12",
			packages: ["@example/senpi"],
		});

		assert.equal(version, "2026.8.12");
	});
});

function installFakeVersionSources(versions) {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-calver-"));
	writeFakeCommand("npm", `process.stdout.write(${JSON.stringify(JSON.stringify(versions))});`);
	writeFakeCommand("git", "");
	previousPath = process.env.PATH;
	process.env.PATH = `${tempDir}${delimiter}${dirname(process.execPath)}`;
}

function writeFakeCommand(name, body) {
	const runner = join(tempDir, `${name}.mjs`);
	writeFileSync(runner, `${body}\n`);
	if (process.platform === "win32") {
		writeFileSync(join(tempDir, `${name}.cmd`), `@"${process.execPath}" "${runner}" %*\r\n`);
		return;
	}
	const executable = join(tempDir, name);
	writeFileSync(executable, `#!${process.execPath}\n${body}\n`);
	chmodSync(executable, 0o755);
}
