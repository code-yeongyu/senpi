#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { computeNextVersion } from "./calver.mjs";
import { queryNpmRegistry } from "./npm-registry.mjs";

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
	it("queries only fork publish targets, never private-only or upstream packages", () => {
		installFakeVersionSources([]);
		const calls = join(tempDir, "calls.jsonl");
		writeFakeCommand("npm", `
			import { appendFileSync } from "node:fs";
			const name = process.argv[3];
			appendFileSync(${JSON.stringify(calls)}, JSON.stringify(name) + "\\n");
			process.stdout.write(JSON.stringify(name === "@code-yeongyu/senpi-telemetry" ? ["2026.9.12-2"] : []));
		`);
		assert.equal(computeNextVersion({ date: "2026.9.12" }), "2026.9.12-3");
		assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse).sort(), [
			"@code-yeongyu/senpi", "@code-yeongyu/senpi-ai", "@code-yeongyu/senpi-agent-core",
			"@code-yeongyu/senpi-tui", "@code-yeongyu/senpi-pty", "@code-yeongyu/senpi-telemetry",
			"@code-yeongyu/senpi-codemode",
		].sort());
	});

	it("treats an unpublished package's E404 as an empty baseline without a warning", (t) => {
		installFakeVersionSources([]);
		writeFakeCommand("npm", 'process.stderr.write("npm error code E404\\n404 Not Found"); process.exit(1);');
		const stderr = t.mock.method(process.stderr, "write", () => true);
		assert.equal(computeNextVersion({ date: "2026.9.12", packages: ["@example/new"] }), "2026.9.12");
		assert.equal(stderr.mock.callCount(), 0);
	});

	it("shares publish lookup handling without hiding registry outages", () => {
		installFakeVersionSources([]);
		writeFakeCommand("npm", 'process.stdout.write(JSON.stringify("2026.9.12-3"));');
		assert.equal(JSON.parse(queryNpmRegistry("@example/senpi@2026.9.12-3", "version")), "2026.9.12-3");
		for (const message of ["E404", "404 Not Found"]) {
			writeFakeCommand("npm", `process.stderr.write(${JSON.stringify(message)}); process.exit(1);`);
			assert.equal(queryNpmRegistry("@example/new", "versions"), null);
		}
		writeFakeCommand("npm", 'process.stderr.write("E503 registry unavailable"); process.exit(1);');
		assert.throws(() => queryNpmRegistry("@example/senpi", "versions"), /E503/);
	});

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
