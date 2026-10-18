#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const crate = join(root, "crates/senpi-grep");
const probe = join(root, "scripts/probe-native-grep.mjs");
const require = createRequire(import.meta.url);
let nativePath;
let native;
let corpus;

function localAddon() {
	return readdirSync(crate).find(
		(name) => name.startsWith(`senpi_grep.${process.platform}-${process.arch}`) && name.endsWith(".node"),
	);
}

before(() => {
	// The addon is intentionally untracked. Fresh script-test CI checkouts build
	// it rather than skipping native coverage or substituting a mock.
	if (!process.env.SENPI_GREP_NATIVE_PATH && !localAddon()) {
		const build = spawnSync(
			"npm",
			["exec", "--yes", "--package", "@napi-rs/cli@3.7.2", "--", "napi", "build", "--platform", "--release", "--", "--locked"],
			{ cwd: crate, encoding: "utf8", timeout: 300_000, shell: process.platform === "win32" },
		);
		assert.ifError(build.error);
		assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
	}
	nativePath = process.env.SENPI_GREP_NATIVE_PATH
		? resolve(process.env.SENPI_GREP_NATIVE_PATH)
		: join(crate, localAddon());
	native = require(nativePath);
	corpus = mkdtempSync(join(tmpdir(), "senpi-grep-test-"));
	writeFileSync(join(corpus, "one.txt"), "needle\n");
});

after(() => {
	if (corpus) rmSync(corpus, { recursive: true, force: true });
});

// Refs #1678: exercise the real N-API boundary, not a Rust-only test or JS stub.
test("load probe searches, aborts, and records the timeout outcome", () => {
	const result = spawnSync(process.execPath, [probe, nativePath], {
		cwd: root,
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	const fields = Object.fromEntries(result.stdout.trim().split(/\s+/).map((field) => field.split("=")));
	assert.equal(fields.sentinel, "1");
	assert.equal(fields.matches, "3");
	assert.equal(fields.aborted, "ABORTED");
	assert.equal(fields.probeFiles, "5000");
	assert.ok(["timedOut", "completed"].includes(fields.timeout));
});

test("probe-files flag controls the generated timeout corpus", () => {
	const result = spawnSync(process.execPath, [probe, nativePath, "--probe-files", "7"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /\bprobeFiles=7\b/);
});

test("generated declarations expose only the promised JS surface", () => {
	const declarations = readFileSync(join(crate, "index.d.ts"), "utf8");
	assert.match(declarations, /function __senpiGrepAbi1\(\): string/);
	assert.match(declarations, /function grep\(options: GrepOptions, signal\?: AbortSignal \| undefined \| null\): Promise<GrepResult>/);
	assert.doesNotMatch(declarations, /\b(?:GrepTask|CancelToken|GrepError)\b/);
});

test("engine errors reject with contract codes and human messages", { timeout: 30_000 }, async () => {
	for (const [overrides, code] of [
		[{ pattern: "(?<=a)b" }, "UNSUPPORTED_REGEX"],
		[{ pcre2: true }, "UNSUPPORTED_REGEX"],
		[{ pattern: "a{" }, "INVALID_PATTERN"],
		[{ glob: ["["] }, "INVALID_GLOB"],
		[{ type: "senpi-no-such-type" }, "UNKNOWN_TYPE"],
		[{ paths: [join(corpus, "missing")] }, "PATH_NOT_FOUND"],
	]) {
		const pending = native.grep({ pattern: "needle", paths: [corpus], cwd: corpus, ...overrides });
		assert.ok(pending instanceof Promise);
		await assert.rejects(pending, (error) => {
			assert.ok(error instanceof Error);
			assert.equal(error.code, code);
			assert.ok(error.message.length > 0);
			assert.notEqual(error.message, code);
			return true;
		});
	}
});

test("one signal cancels concurrent calls and can be reused after completion", { timeout: 30_000 }, async () => {
	const controller = new AbortController();
	const options = { pattern: "needle", paths: [corpus], cwd: corpus };
	let observed = 0;
	controller.signal.onabort = () => observed++;
	assert.equal((await native.grep(options, controller.signal)).matches.length, 1);
	const first = assert.rejects(native.grep(options, controller.signal), { code: "ABORTED" });
	const second = assert.rejects(native.grep(options, controller.signal), { code: "ABORTED" });
	// Both rejections are subscribed before abort; settlement cannot race this
	// synchronous trigger even if the libuv worker has already finished compute.
	controller.abort();
	await Promise.all([first, second]);
	assert.equal(observed, 1);
	await assert.rejects(native.grep(options, controller.signal), { code: "ABORTED" });
});

test("plain results preserve nullable counts and optional columns", { timeout: 30_000 }, async () => {
	const options = { pattern: "needle", paths: [corpus], cwd: corpus };
	const result = await native.grep(options, null);
	assert.equal(Object.getPrototypeOf(result), Object.prototype);
	assert.equal(result.matches[0].column, 1);
	assert.equal(result.matches[0].isContext, false);
	assert.equal(result.regexEngine, "rust");
	const files = await native.grep({ ...options, mode: "files" });
	assert.equal(files.counts.matches, null);
	assert.equal(files.fileCounts[0].count, null);
	assert.deepEqual(files.matches, []);
});
