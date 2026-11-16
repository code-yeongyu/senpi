import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// senpi#6488: the benchmarks import the suite harness from a plain bun process. A hook the harness registered at import
// ("Vitest failed to find the current suite") made that import throw, so the harness must stay loadable outside Vitest.
it("loads the suite harness outside a Vitest run", () => {
	const harness = pathToFileURL(join(import.meta.dirname, "../harness.ts")).href;
	const run = spawnSync("bun", ["-e", `await import(${JSON.stringify(harness)}); console.log("harness loaded");`], {
		encoding: "utf8",
	});
	expect({ status: run.status, stdout: run.stdout.trim(), error: run.stderr.match(/Vitest[^\n]*/)?.[0] }).toEqual({
		status: 0,
		stdout: "harness loaded",
		error: undefined,
	});
});

// Outside Vitest nothing joins a recorded cleanup, so a script must await it: a failed removal then reaches the script.
// Root ignores the directory's permissions, so the removal cannot be made to fail there: the case is skipped, visibly.
it.skipIf(process.getuid?.() === 0)("reports a failed removal to a script that awaits cleanup() outside Vitest", () => {
	const harness = pathToFileURL(join(import.meta.dirname, "../harness.ts")).href;
	const script = `
		import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
		import { join } from "node:path";
		const { createHarness } = await import(${JSON.stringify(harness)});
		const fixture = await createHarness();
		const locked = join(fixture.tempDir, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "file"), "");
		chmodSync(locked, 0o500);
		try {
			await fixture.cleanup();
			console.log("cleanup resolved");
		} catch (error) {
			console.log("cleanup failed " + error.code);
		} finally {
			chmodSync(locked, 0o700);
			rmSync(fixture.tempDir, { recursive: true, force: true });
		}
	`;
	const run = spawnSync("bun", ["-e", script], { encoding: "utf8" });
	expect({ status: run.status, stdout: run.stdout.trim().split("\n").at(-1) }).toEqual({
		status: 0,
		stdout: "cleanup failed EACCES",
	});
});
