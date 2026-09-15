#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const npmrc = readFileSync(join(repoRoot, ".npmrc"), "utf8").replace(/^min-release-age-exclude\[\]=(marked|zod)\r?\n/gm, "");

for (const script of ["check:pinned-deps", "preinstall"]) {
	for (const scenario of [
		{ name: "accepts reviewed exceptions through their expiry date", now: "2026-09-15T23:59:59.999Z", active: true, status: 0 },
		{ name: "rejects active exceptions after their expiry date", now: "2026-09-16T00:00:00.000Z", active: true, status: 1 },
		{ name: "accepts removed exceptions after their expiry date", now: "2026-09-16T00:00:00.000Z", active: false, status: 0 },
	]) {
		it(`${script} ${scenario.name}`, (t) => {
			// Given: the real package-manager entry point and configuration, with a fixed clock.
			const root = mkdtempSync(join(tmpdir(), "senpi-release-age-"));
			t.after(() => rmSync(root, { recursive: true, force: true }));
			mkdirSync(join(root, "scripts"));
			for (const file of ["check-pinned-deps.mjs", "create-bin-stubs.mjs", "check-release-age-exceptions.mjs"]) {
				const source = join(repoRoot, "scripts", file);
				copyFileSync(source, join(root, "scripts", file));
			}
			writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, scripts: { [script]: manifest.scripts[script] } }));
			writeFileSync(join(root, ".npmrc"), npmrc + (scenario.active ? "min-release-age-exclude[]=marked\nmin-release-age-exclude[]=zod\n" : ""));
			const clockPath = join(root, "clock.mjs");
			writeFileSync(clockPath, `import { mock } from "node:test"; mock.timers.enable({ apis: ["Date"], now: ${Date.parse(scenario.now)} });`);

			// When: npm runs the shipped validation or install hook after/before the cutoff.
			const result = spawnSync("npm", ["run", script], {
				cwd: root,
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(clockPath).href}` },
			});

			// Then: expired active exceptions fail, rather than silently accepting stale policy.
			assert.equal(result.status, scenario.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
			if (scenario.status === 1) {
				const diagnostics = result.stderr.split("\n").filter((line) => line.startsWith("{\"code\":")).map((line) => JSON.parse(line));
				assert.deepEqual(diagnostics.map(({ code, packageName }) => ({ code, packageName })), [
					{ code: "release_age_exception_expired", packageName: "marked" },
					{ code: "release_age_exception_expired", packageName: "zod" },
				]);
			}
		});
	}
}
