import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// omo#12965: CI runs the eval kernels under Bun in a tree that is installed but not built (the process-isolation,
// WebView and Python cold-startup jobs). The kernel graph imports the realm-registry helper, whose package entry is
// build output, so this package's tsconfig maps the helper to its source, as it maps the engine. Bun resolves an
// import through the tsconfig nearest to the importing file.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const importerDir = resolve(packageRoot, "src/kernels/shared");

describe("the kernel graph under Bun in a tree that is installed but not built (omo#12965)", () => {
	it.runIf(bunAvailable)("resolves the realm-registry helper to its source", () => {
		const resolveHelper = `Bun.resolveSync("@earendil-works/pi-realm-registry", ${JSON.stringify(importerDir)})`;
		const script = `console.log(require("node:fs").realpathSync(${resolveHelper}))`;

		const run = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: packageRoot, timeout: 60_000 });

		expect(run.stdout.trim()).toBe(realpathSync(resolve(packageRoot, "../realm-registry/src/index.ts")));
	});
});
