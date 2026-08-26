import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * The CLI pays a V8 compile cost for its whole module graph on every launch, and `cli.ts` spawns
 * `cli-main.js` as a child process, so the child re-pays it too. `enableStartupCompileCache()`
 * turns on Node's on-disk code cache and — because Node does NOT export `NODE_COMPILE_CACHE`
 * into `process.env` itself — publishes the resolved base directory so spawned children inherit
 * the same cache instead of writing their own.
 *
 * These tests drive the real seam through child processes: the cache directory is an observable
 * artifact, so they assert on it rather than on how the module calls Node.
 */

const MODULE_PATH = resolve(__dirname, "..", "src", "compile-cache.ts");

// Loads the seam, then reports what a spawned child would inherit plus the effective cache dir.
const driverSource = `import { getCompileCacheDir } from "node:module";
const { enableStartupCompileCache } = await import(process.env.MODULE_URL);
enableStartupCompileCache();
// Compile something after the call: ESM static imports are hoisted, so only modules loaded
// after enablement can populate the cache.
await import(process.env.PAYLOAD_URL);
console.log(JSON.stringify({
	inherited: process.env.NODE_COMPILE_CACHE ?? null,
	effective: getCompileCacheDir() ?? null,
}));
`;

const payloadSource = `export const value = ${JSON.stringify("x".repeat(2048))}.length;\n`;

let hostDir: string;

function runDriver(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
	const driver = join(hostDir, "driver.mjs");
	const payload = join(hostDir, "payload.mjs");
	writeFileSync(driver, driverSource);
	writeFileSync(payload, payloadSource);
	const result = spawnSync(process.execPath, [driver], {
		encoding: "utf8",
		env: { ...process.env, MODULE_URL: MODULE_PATH, PAYLOAD_URL: payload, ...env },
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseReport(stdout: string): { inherited: string | null; effective: string | null } {
	const line = stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(line) as { inherited: string | null; effective: string | null };
}

function cacheFileCount(dir: string): number {
	if (!existsSync(dir)) {
		return 0;
	}
	// Node nests entries under a <version>-<arch>-<hash>-<uid> subdirectory.
	return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
}

beforeEach(() => {
	hostDir = mkdtempSync(join(tmpdir(), "senpi-compile-cache-"));
});

afterEach(() => {
	rmSync(hostDir, { recursive: true, force: true });
});

describe("startup compile cache", () => {
	describe("#given a fresh cache directory", () => {
		test("#when the seam runs #then it populates the cache and children inherit that exact directory", () => {
			const cacheDir = join(hostDir, "cache");

			const first = runDriver({ NODE_COMPILE_CACHE: cacheDir });

			expect(first.status, first.stderr).toBe(0);
			expect(cacheFileCount(cacheDir)).toBeGreaterThan(0);

			const report = parseReport(first.stdout);
			// A child must receive the base directory, not the versioned subdirectory: passing the
			// latter makes Node nest a second version segment inside it and miss the parent's entries.
			expect(report.inherited).toBe(cacheDir);
			expect(report.effective?.startsWith(cacheDir)).toBe(true);
		});

		test("#when no cache directory is configured #then the seam still publishes an inheritable default", () => {
			const result = runDriver({ NODE_COMPILE_CACHE: undefined, TMPDIR: hostDir });

			expect(result.status, result.stderr).toBe(0);
			const report = parseReport(result.stdout);
			expect(report.inherited).not.toBeNull();
			expect(report.effective?.startsWith(report.inherited ?? "\u0000")).toBe(true);
		});
	});

	describe("#given a caller that already chose a cache directory", () => {
		test("#when NODE_COMPILE_CACHE is preset #then the seam keeps it instead of overriding", () => {
			const preset = join(hostDir, "preset");

			const result = runDriver({ NODE_COMPILE_CACHE: preset });

			expect(result.status, result.stderr).toBe(0);
			expect(parseReport(result.stdout).inherited).toBe(preset);
		});
	});

	describe("#given the cache is disabled", () => {
		test("#when NODE_DISABLE_COMPILE_CACHE=1 #then the seam does not throw and writes nothing", () => {
			const cacheDir = join(hostDir, "disabled-cache");

			const result = runDriver({ NODE_DISABLE_COMPILE_CACHE: "1", NODE_COMPILE_CACHE: cacheDir });

			expect(result.status, result.stderr).toBe(0);
			expect(cacheFileCount(cacheDir)).toBe(0);
		});
	});

	describe("#given a runtime whose compile-cache API is missing or inert (the bun-compiled binary)", () => {
		test("#when the seam runs under a stubbed-out node:module #then it neither throws nor publishes a directory", () => {
			const probe = join(hostDir, "probe.mjs");
			// A loader hook replaces node:module wholesale, so the seam's own static import binding
			// resolves to a namespace with no enableCompileCache - the shape dist/pi runs under.
			const hooks = join(hostDir, "hooks.mjs");
			writeFileSync(
				hooks,
				`export async function resolve(specifier, context, next) {
	if (specifier === "node:module") {
		return { url: "stub:module", shortCircuit: true };
	}
	return next(specifier, context);
}
export async function load(url, context, next) {
	if (url === "stub:module") {
		return { format: "module", shortCircuit: true, source: "export const syncBuiltinESMExports = () => {};" };
	}
	return next(url, context);
}
`,
			);
			writeFileSync(
				probe,
				`import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(pathToFileURL(process.env.HOOKS_PATH));
const { enableStartupCompileCache } = await import(process.env.MODULE_URL);
enableStartupCompileCache();
console.log("SURVIVED " + JSON.stringify(process.env.NODE_COMPILE_CACHE ?? null));
`,
			);
			const result = spawnSync(process.execPath, [probe], {
				encoding: "utf8",
				env: { ...process.env, MODULE_URL: MODULE_PATH, HOOKS_PATH: hooks, NODE_COMPILE_CACHE: undefined },
			});

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("SURVIVED null");
		});
	});
});
