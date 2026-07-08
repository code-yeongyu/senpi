#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
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

describe("local release package list", () => {
	it("builds and packs the pty workspace for bundled senpi installs", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-local-release-flow-"));
		const repoRoot = join(tempDir, "repo");
		const outDir = join(tempDir, "out");
		const fakeNpmLog = join(tempDir, "fake-npm.jsonl");
		const fakeNpm = join(tempDir, "bin", "npm");
		writeFakeNpm(fakeNpm);
		writeLocalReleaseFixture(repoRoot);

		// When
		const result = spawnSync(
			process.execPath,
			[join(process.cwd(), "scripts", "local-release.mjs"), "--skip-check", "--skip-install", "--out", outDir],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${dirname(fakeNpm)}${delimiter}${process.env.PATH ?? ""}`,
					SENPI_FAKE_NPM_LOG: fakeNpmLog,
				},
			},
		);

		// Then
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const ptyDirectorySuffix = `${sep}packages${sep}pty`;
		const npmCalls = readFileSync(fakeNpmLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.ok(
			npmCalls.some((call) => call.cwd.endsWith(ptyDirectorySuffix) && call.args.join(" ") === "run build"),
			"expected local-release to build packages/pty",
		);
		assert.ok(
			npmCalls.some((call) => call.cwd.endsWith(ptyDirectorySuffix) && call.args[0] === "pack"),
			"expected local-release to pack packages/pty",
		);
		assert.equal(existsSync(join(outDir, "tarballs", "earendil-works-pi-pty-0.0.0.tgz")), true);
	});
});

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

function writeFakeNpm(path) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		[
			"#!/usr/bin/env node",
			'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"const args = process.argv.slice(2);",
			"if (process.env.SENPI_FAKE_NPM_LOG) {",
			"  writeFileSync(process.env.SENPI_FAKE_NPM_LOG, `${JSON.stringify({ cwd: process.cwd(), args })}\\n`, { flag: 'a' });",
			"}",
			"if (args[0] === 'pack') {",
			"  const destination = args[args.indexOf('--pack-destination') + 1];",
			"  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));",
			"  const filename = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`;",
			"  mkdirSync(destination, { recursive: true });",
			"  writeFileSync(join(destination, filename), 'fake tarball');",
			"  process.stdout.write(JSON.stringify([{ filename, files: [] }]));",
			"}",
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

function writeLocalReleaseFixture(repoRoot) {
	writeJson(join(repoRoot, "package.json"), { name: "senpi-monorepo", private: true });
	writeJson(join(repoRoot, "packages", "coding-agent", "npm-shrinkwrap.json"), {
		lockfileVersion: 3,
		packages: {},
	});
	for (const [directory, name] of [
		["packages/ai", "@earendil-works/pi-ai"],
		["packages/pty", "@earendil-works/pi-pty"],
		["packages/tui", "@earendil-works/pi-tui"],
		["packages/agent", "@earendil-works/pi-agent-core"],
		["packages/senpi-codemode", "@code-yeongyu/senpi-codemode"],
		["packages/coding-agent", "@code-yeongyu/senpi"],
		["packages/orchestrator", "@code-yeongyu/senpi-orchestrator"],
	]) {
		writeJson(join(repoRoot, directory, "package.json"), { name, version: "0.0.0" });
		mkdirSync(join(repoRoot, directory, "dist"), { recursive: true });
		writeFileSync(join(repoRoot, directory, "dist", "index.js"), "");
	}

	const nativeTarget = `${process.platform}-${process.arch}`;
	mkdirSync(join(repoRoot, "packages", "pty", "native"), { recursive: true });
	writeFileSync(join(repoRoot, "packages", "pty", "native", "index.js"), "");
	mkdirSync(join(repoRoot, "packages", "pty", "native", "prebuilds", nativeTarget), { recursive: true });
	writeFileSync(
		join(repoRoot, "packages", "pty", "native", "prebuilds", nativeTarget, `senpi_pty.${nativeTarget}.node`),
		"",
	);

	// senpi-codemode is bundled source-only; prepareSenpiBundledWorkspaces requires its loader-visible sources.
	mkdirSync(join(repoRoot, "packages", "senpi-codemode", "src", "kernels", "py"), { recursive: true });
	writeFileSync(join(repoRoot, "packages", "senpi-codemode", "src", "index.ts"), "");
	writeFileSync(join(repoRoot, "packages", "senpi-codemode", "src", "kernels", "py", "prelude.py"), "");
}
