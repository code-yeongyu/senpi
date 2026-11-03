import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { SOURCE_COMPILE_CACHE_ENV } from "../src/experimental/source-compile-cache.ts";
import setupSourceCompileCache, { removeRunDirectory } from "./helpers/source-compile-cache-global-setup.ts";

const resolverUrl = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;
const probePath = fileURLToPath(new URL("./fixtures/source-compile-cache-probe.ts", import.meta.url));
const directories = new Set<string>();

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

function launchProbe(cacheDirectory: string | undefined): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.NODE_COMPILE_CACHE;
	delete env.NODE_DISABLE_COMPILE_CACHE;
	delete env[SOURCE_COMPILE_CACHE_ENV];
	if (cacheDirectory !== undefined) env[SOURCE_COMPILE_CACHE_ENV] = cacheDirectory;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", resolverUrl, probePath], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0 && stderr === "") resolve(stdout);
			else reject(new Error(`probe exited with ${code}, stderr: ${stderr}`));
		});
	});
}

describe("source process compile cache", () => {
	test("a source launch without a run directory compiles without a cache", async () => {
		await expect(launchProbe(undefined)).resolves.toBe("");
	});

	test("a source launch stores its compiled modules under the run directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "senpi-scc-"));
		directories.add(directory);

		const reported = await launchProbe(directory);

		expect(reported.startsWith(directory)).toBe(true);
		const entries = await readdir(directory, { recursive: true, withFileTypes: true });
		expect(entries.some((entry) => entry.isFile())).toBe(true);
	});

	test("the test run hands its workers a run directory for source launches", async () => {
		const directory = process.env[SOURCE_COMPILE_CACHE_ENV];

		expect(directory).toBeDefined();
		await expect(stat(directory ?? "")).resolves.toMatchObject({ isDirectory: expect.any(Function) });
	});
});

describe("source compile cache global setup", () => {
	const inherited = process.env[SOURCE_COMPILE_CACHE_ENV];

	afterEach(() => {
		if (inherited === undefined) delete process.env[SOURCE_COMPILE_CACHE_ENV];
		else process.env[SOURCE_COMPILE_CACHE_ENV] = inherited;
	});

	test("creates one run directory and removes it at teardown", () => {
		delete process.env[SOURCE_COMPILE_CACHE_ENV];

		const teardown = setupSourceCompileCache();
		const directory = process.env[SOURCE_COMPILE_CACHE_ENV];

		try {
			expect(teardown).toBeTypeOf("function");
			expect(directory).toBeDefined();
			expect(existsSync(directory ?? "")).toBe(true);
		} finally {
			// senpi#5011: run teardown even when an assertion above fails, so a
			// failing run does not leave its temp directory behind.
			teardown?.();
		}
		expect(process.env[SOURCE_COMPILE_CACHE_ENV]).toBeUndefined();
		expect(existsSync(directory ?? "")).toBe(false);
	});

	// Stands in for the detached source processes of a run flushing Node's compile cache while the run tears
	// down: each writes entries the way Node persists them (create a temporary file, rename it over the
	// entry) without pause, and stops at the first write that finds the directory gone. Eight writers keep
	// the directory from ever being empty while an in-place delete walks it, so that delete fails every
	// time instead of by chance.
	const CACHE_WRITERS = 8;
	const CACHE_WRITER = [
		'const { mkdirSync, renameSync, writeFileSync } = require("node:fs");',
		'const { join } = require("node:path");',
		'const tagged = join(process.argv[1], "v-test");',
		"mkdirSync(tagged, { recursive: true });",
		"for (let entry = 0; ; entry += 1) {",
		'\tconst target = join(tagged, process.pid + "-" + entry.toString(16));',
		"\ttry {",
		'\t\twriteFileSync(target + ".tmp", "cache", { flag: "wx" });',
		'\t\trenameSync(target + ".tmp", target);',
		'\t} catch (error) { process.stdout.write("stopped " + error.code + "\\n"); process.exit(0); }',
		'\tif (entry === 0) process.stdout.write("writing\\n");',
		"}",
	].join("\n");

	function startCacheWriter(directory: string): Promise<{ child: ChildProcess; stopped: Promise<string> }> {
		const child = spawn(process.execPath, ["-e", CACHE_WRITER, directory], { stdio: ["ignore", "pipe", "inherit"] });
		let output = "";
		const stopped = new Promise<string>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => resolve(output));
		});
		return new Promise((resolve, reject) => {
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.startsWith("writing")) resolve({ child, stopped });
			});
			child.once("exit", () => reject(new Error(`cache writer exited before writing: ${output}`)));
		});
	}

	test("removes the run directory while source processes are still writing their compile cache", async () => {
		delete process.env[SOURCE_COMPILE_CACHE_ENV];
		const teardown = setupSourceCompileCache();
		const directory = process.env[SOURCE_COMPILE_CACHE_ENV] ?? "";
		const writers = await Promise.all(Array.from({ length: CACHE_WRITERS }, () => startCacheWriter(directory)));

		// A writer only stops by itself once the directory is gone, so every failure here stops them all before
		// the test ends instead of leaving unbounded write loops on the worker (senpi#5678).
		let removed = false;
		try {
			expect(() => teardown?.()).not.toThrow();
			expect(existsSync(directory), "teardown left the run directory").toBe(false);
			expect(existsSync(`${directory}-removing`), "teardown left the renamed run directory").toBe(false);
			removed = true;
		} finally {
			if (!removed) for (const writer of writers) writer.child.kill();
		}

		for (const output of await Promise.all(writers.map((writer) => writer.stopped))) {
			expect(output).toContain("stopped ENOENT");
		}
	});

	// A write that resolved the old path before the rename lands in the renamed tree while the delete walks it.
	// Node's compile cache writes a temporary file and renames it over the entry, so such a write can take an
	// entry away between the walk listing it and unlinking it; Node 24's rmSync then reads that ENOENT as "the
	// path is already gone" and returns without an error, leaving the tree (senpi#5678). A create that lands
	// after the walk instead fails the final rmdir with ENOTEMPTY. Each case forces its write into the first
	// delete pass, after the rename.
	test.each([
		{
			case: "returns without an error while an entry it listed was renamed away",
			firstPass: (removing: string) => {
				renameSync(join(removing, "v-test", "entry.tmp"), join(removing, "v-test", "entry"));
			},
		},
		{
			case: "fails with ENOTEMPTY while an entry was created after its walk",
			firstPass: (removing: string) => {
				rmSync(join(removing, "v-test", "entry.tmp"));
				writeFileSync(join(removing, "v-test", "late.tmp"), "cache");
				throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rm '${removing}'`), { code: "ENOTEMPTY" });
			},
		},
	])("deletes the renamed run directory when a delete pass $case", ({ firstPass }) => {
		const directory = mkdtempSync(join(tmpdir(), "senpi-source-compile-cache-"));
		directories.add(directory).add(`${directory}-removing`);
		mkdirSync(join(directory, "v-test"));
		writeFileSync(join(directory, "v-test", "entry.tmp"), "cache");
		let passes = 0;

		removeRunDirectory(directory, (removing) => {
			passes += 1;
			if (passes === 1) firstPass(removing);
			else rmSync(removing, { recursive: true, force: true });
		});

		expect(existsSync(directory)).toBe(false);
		expect(existsSync(`${directory}-removing`), "teardown left the renamed run directory").toBe(false);
		expect(passes).toBe(2);
	});

	test("fails naming the renamed run directory and the last error when every delete pass leaves it", () => {
		const directory = mkdtempSync(join(tmpdir(), "senpi-source-compile-cache-"));
		directories.add(directory).add(`${directory}-removing`);
		const notEmpty = Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });

		let thrown: unknown;
		try {
			removeRunDirectory(directory, () => {
				throw notEmpty;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown instanceof Error ? thrown.message : "").toContain(`${directory}-removing`);
		expect(thrown instanceof Error ? thrown.cause : undefined).toBe(notEmpty);
		expect(existsSync(`${directory}-removing`)).toBe(true);
	});

	test("keeps a directory the caller already named", () => {
		process.env[SOURCE_COMPILE_CACHE_ENV] = "/caller/chosen/directory";

		expect(setupSourceCompileCache()).toBeUndefined();
		expect(process.env[SOURCE_COMPILE_CACHE_ENV]).toBe("/caller/chosen/directory");
	});
});
