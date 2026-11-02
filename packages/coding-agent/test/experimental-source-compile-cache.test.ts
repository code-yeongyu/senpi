import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { SOURCE_COMPILE_CACHE_ENV } from "../src/experimental/source-compile-cache.ts";
import setupSourceCompileCache from "./helpers/source-compile-cache-global-setup.ts";

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

		expect(teardown).toBeTypeOf("function");
		expect(directory).toBeDefined();
		expect(existsSync(directory ?? "")).toBe(true);
		teardown?.();
		expect(process.env[SOURCE_COMPILE_CACHE_ENV]).toBeUndefined();
		expect(existsSync(directory ?? "")).toBe(false);
	});

	test("keeps a directory the caller already named", () => {
		process.env[SOURCE_COMPILE_CACHE_ENV] = "/caller/chosen/directory";

		expect(setupSourceCompileCache()).toBeUndefined();
		expect(process.env[SOURCE_COMPILE_CACHE_ENV]).toBe("/caller/chosen/directory");
	});
});
