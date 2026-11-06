#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { parse } from "shell-quote";
import { bunReleaseExternalFlags } from "./bun-release-externals.mjs";

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
			"./src/modes/rpc/loopless-worker.ts",
			"./src/utils/image-resize-worker.ts",
			"./src/core/extensions/builtin/permission-system/path-identity-worker.ts",
			"./src/core/kill-guard/index.ts",
		]) {
			assert.ok(argv.includes(entry), `${name}: missing ${entry}`);
		}
		assert.ok(!argv.some((argument) => String(argument).includes("xhr-sync-worker.js")));
	});

	test(`${name} keeps linkedom's optional canvas binding external when compiling standalone entries`, () => {
		// When
		const argv = compileArgv(command);
		// Then: compiling must not resolve canvas's native binding (senpi#6045).
		const external = argv.flatMap((argument, index) => (argument === "--external" ? [argv[index + 1]] : []));
		for (let index = 0; index < bunReleaseExternalFlags.length; index += 2) {
			assert.ok(external.includes(bunReleaseExternalFlags[index + 1]), `${name}: missing ${bunReleaseExternalFlags.slice(index, index + 2).join(" ")}`);
		}
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

// Every JS/TS Bun build of the release entry graph takes its externals from one module (senpi#6045), so a
// new call site cannot silently need canvas's native binding again.
const repoRoot = new URL("..", import.meta.url);
function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(?:mjs|cjs|js|ts|mts)$/.test(entry.name) ? [path] : [];
	});
}
const root = repoRoot.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const packagesDir = join(root, "packages");
const scanned = [
	...sourceFiles(join(root, "scripts")),
	...readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			try {
				return sourceFiles(join(packagesDir, entry.name, "scripts"));
			} catch {
				return [];
			}
		}),
];
const bunBuildCall = /["']build["']\s*,\s*["']--(?:compile|target=bun)["']|["']--compile["']\s*,/;
const releaseGraph = /dist\/bun\/cli\.js|build:binary/;
const releaseGraphBuilders = scanned
	.filter((path) => !path.endsWith("build-binaries-flags.test.mjs"))
	.filter((path) => {
		const source = readFileSync(path, "utf8");
		return bunBuildCall.test(source) && releaseGraph.test(source);
	})
	.map((path) => relative(root, path).replaceAll("\\", "/"));

test("finds the known release-graph Bun builders when scanning scripts", () => {
	// Then: the scan itself is not vacuous.
	for (const known of [
		"scripts/compiled-extension-load.test.ts",
		"scripts/bun-bundle-provider-coverage.test.ts",
		"scripts/release-graph-codemode.test.ts",
		"scripts/release-graph-exclusions.test.ts",
		"packages/coding-agent/scripts/qa-rpc-socket/lib/compiled-generations.mjs",
	]) {
		assert.ok(releaseGraphBuilders.includes(known), `scan missed ${known}`);
	}
});

for (const path of releaseGraphBuilders) {
	test(`${path} spreads the shared release externals when building the release entry graph`, () => {
		// When
		const source = readFileSync(join(root, path), "utf8");
		// Then
		assert.match(source, /import \{ bunReleaseExternalFlags \} from "(?:\.\.?\/)+(?:scripts\/)?bun-release-externals\.mjs";/);
		assert.match(source, /\.\.\.bunReleaseExternalFlags/);
	});
}
