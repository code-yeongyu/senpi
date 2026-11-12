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
