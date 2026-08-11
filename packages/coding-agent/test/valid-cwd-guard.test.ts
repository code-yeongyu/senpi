import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A shell whose cwd was deleted (a removed worktree or checkout) still starts our CLI: Node boots
 * with the stale handle and only throws uv_cwd when something evaluates process.cwd(). The bundled
 * agent SDK does that at module-evaluation time, so the process dies before any user code can
 * recover. These tests reproduce that exact shape in a child process and pin the recovery guard.
 */

const driverSource = `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "senpi-cwd-guard-"));
process.chdir(dir);
rmSync(dir, { recursive: true, force: true });
if (process.env.WITH_GUARD === "1") await import(process.env.GUARD_URL);
await import(process.env.PROBE_URL);
console.log("CWD_OK=" + process.cwd());
`;

const probeSource = `// Mimics the bundled agent SDK: resolves the cwd during module evaluation.
process.cwd();
`;

function runChild(withGuard: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-cwd-guard-host-"));
	try {
		const driver = join(dir, "driver.mjs");
		const probe = join(dir, "probe.mjs");
		writeFileSync(driver, driverSource);
		writeFileSync(probe, probeSource);
		return spawnSync(process.execPath, [driver], {
			encoding: "utf8",
			env: {
				...process.env,
				WITH_GUARD: withGuard ? "1" : "0",
				GUARD_URL: resolve(__dirname, "..", "src", "valid-cwd.ts"),
				PROBE_URL: probe,
			},
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("valid-cwd startup guard", () => {
	describe("#given a process whose cwd was deleted before launch", () => {
		test("#when a module resolves process.cwd() without the guard #then it crashes with uv_cwd", () => {
			const result = runChild(false);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("uv_cwd");
		});

		test("#when the guard is imported first #then startup recovers into the home directory", () => {
			const result = runChild(true);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("CWD_OK=");
			expect(result.stdout).not.toContain("senpi-cwd-guard-");
		});
	});

	describe("#given the CLI entrypoints", () => {
		test.each(["src/cli.ts", "src/cli-main.ts"])("#when %s is read #then the guard is its first import", (entry) => {
			const source = require("node:fs").readFileSync(resolve(__dirname, "..", entry), "utf8");
			const firstImport = source.split("\n").find((line: string) => line.startsWith("import "));
			expect(firstImport).toBe('import "./valid-cwd.ts";');
		});
	});
});
