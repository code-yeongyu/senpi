import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSyncRetry } from "./rm-sync-retry.mjs";

const permissionSystem = resolve(import.meta.dir, "../packages/coding-agent/src/core/extensions/builtin/permission-system");
const host = join(permissionSystem, "path-identity-host.ts");
const worker = join(permissionSystem, "path-identity-worker.ts");

test("the compiled and relocated host resolves a symlinked path through its embedded worker", () => {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-compiled-path-identity-"));
	try {
		// Given: the real host and the real worker, compiled in the release layout: the main entry under
		// dist/bun/, the worker as an explicit entry at its source path, no --root (the common directory of
		// the entries is the package root), so the compiled host must name the worker by that source path.
		const root = join(scratch, "source");
		const workerDir = join(root, "src", "core", "extensions", "builtin", "permission-system");
		mkdirSync(join(root, "dist", "bun"), { recursive: true });
		mkdirSync(workerDir, { recursive: true });
		const entry = join(root, "dist", "bun", "entry.ts");
		const workerEntry = join(workerDir, "path-identity-worker.ts");
		writeFileSync(workerEntry, `import ${JSON.stringify(worker)};\n`);
		writeFileSync(
			entry,
			`import { realpathSync } from "node:fs";
import { createPathIdentityResolver } from ${JSON.stringify(host)};
const fixture = process.argv[2];
const resolver = createPathIdentityResolver({ log: () => {} });
try {
  const canonical = await resolver.canonicalize(fixture + "/link/secret");
  console.log(JSON.stringify({ canonical: canonical.path, expected: realpathSync.native(fixture) + "/real/secret", unavailable: resolver.unavailable ?? null }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error), unavailable: resolver.unavailable ?? null }));
  process.exitCode = 2;
} finally {
  await resolver.close();
}
`,
		);
		const filename = process.platform === "win32" ? "senpi.exe" : "senpi";
		const binary = join(scratch, filename);
		const built = spawnSync(
			process.execPath,
			[
				"build",
				"--compile",
				"--splitting",
				"--minify",
				"--keep-names",
				"./dist/bun/entry.ts",
				"./src/core/extensions/builtin/permission-system/path-identity-worker.ts",
				"--outfile",
				binary,
			],
			{ cwd: root, encoding: "utf8", timeout: 120_000 },
		);
		expect(built.status, built.stderr).toBe(0);

		// When: the compiled process runs with neither its build tree nor its original cwd.
		const relocated = join(scratch, "relocated");
		mkdirSync(join(relocated, "fixture", "real"), { recursive: true });
		writeFileSync(join(relocated, "fixture", "real", "secret"), "S");
		symlinkSync(join(relocated, "fixture", "real"), join(relocated, "fixture", "link"));
		const moved = join(relocated, filename);
		renameSync(binary, moved);
		rmSync(root, { recursive: true });
		const result = spawnSync(moved, [join(relocated, "fixture")], {
			cwd: relocated,
			encoding: "utf8",
			timeout: 30_000,
			env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: relocated, USERPROFILE: relocated },
		});

		// Then: the worker answered from inside the binary.
		expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
		const report = JSON.parse(result.stdout) as { canonical?: string; expected?: string; unavailable: string | null };
		expect(report.unavailable).toBeNull();
		expect(report.canonical).toBe(report.expected);
	} finally {
		const cleanup = rmSyncRetry(scratch);
		if (!cleanup.removed) console.warn(`left scratch directory ${scratch}: ${String(cleanup.error)}`);
	}
}, 180_000);
