#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "shell-quote";

// Given: parse actual shell argv, excluding adjacent commands and their arguments.
function compileArgv(command) {
	const tokens = parse(command, (name) => `$${name}`);
	const start = tokens.findIndex((token, index) => token === "bun" && tokens[index + 1] === "build");
	assert.notEqual(start, -1, "missing bun build command");
	const end = tokens.findIndex((token, index) => index > start && typeof token !== "string");
	return tokens.slice(start, end === -1 ? undefined : end);
}

const script = readFileSync(new URL("./build-binaries.sh", import.meta.url), "utf8");
const releaseCommands = script.split("\n").filter((line) => /^\s*bun build --compile\b/.test(line));
const manifest = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));

test("discovers both release compile commands when reading the release script", () => {
	// When / Then: neither platform branch may silently disappear from coverage.
	assert.equal(releaseCommands.length, 2);
});

const commands = [
	...releaseCommands.map((command) => ({
		name: command.includes("pi.exe") ? "release win32" : "release non-win32",
		command,
	})),
	{ name: "package build:binary", command: manifest.scripts["build:binary"] },
];

for (const { name, command } of commands) {
	test(`${name} enables splitting when compiling standalone entries`, () => {
		// When
		const argv = compileArgv(command);
		// Then
		assert.ok(argv.includes("--splitting"), `${name}: missing --splitting`);
	});

	test(`${name} preserves minification when compiling standalone entries`, () => {
		// When
		const argv = compileArgv(command);
		// Then
		assert.ok(argv.includes("--minify"), `${name}: missing --minify`);
		assert.ok(argv.includes("--keep-names"), `${name}: missing --keep-names`);
	});

	test(`${name} embeds all workers when compiling standalone entries`, () => {
		// When
		const argv = compileArgv(command);
		// Then
		for (const entry of [
			"./dist/bun/cli.js",
			"./src/modes/rpc/session-worker.ts",
			"./src/utils/image-resize-worker.ts",
		]) {
			assert.ok(argv.includes(entry), `${name}: missing ${entry}`);
		}
		assert.ok(!argv.some((argument) => String(argument).includes("xhr-sync-worker.js")));
	});

	test(`${name} preserves autoload isolation when compiling standalone entries`, () => {
		// When
		const argv = compileArgv(command);
		// Then
		assert.ok(argv.includes("--no-compile-autoload-dotenv"));
		assert.ok(argv.includes("--no-compile-autoload-bunfig"));
		assert.ok(argv.includes("--compile-autoload-package-json"));
	});
}
