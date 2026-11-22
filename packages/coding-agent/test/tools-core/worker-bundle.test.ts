import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Package contract: `@code-yeongyu/senpi/tools-core` is the entry a non-Node host (a Worker) bundles to run
// bash/read/write/edit through an injected ToolMachine, so no Node or Bun builtin may be reachable from it.
const bundleScript = fileURLToPath(new URL("./support/bundle-browser.ts", import.meta.url));
const toolsCoreEntry = fileURLToPath(new URL("../../src/tools-core.ts", import.meta.url));

interface BundleReport {
	success: boolean;
	errors: string[];
	reachedBuiltins: string[];
	builtinImportsInOutput: string[];
	lazyExternals: string[];
	nodeGlobals: string[];
}

describe("tools-core entry", () => {
	it("bundles for a browser target with no Node builtin in its module graph", async () => {
		const { stdout } = await promisify(execFile)("bun", [bundleScript, toolsCoreEntry], {
			maxBuffer: 16 * 1024 * 1024,
		});
		const report = JSON.parse(stdout) as BundleReport;

		expect(report.reachedBuiltins).toEqual([]);
		expect(report.errors).toEqual([]);
		expect(report.success).toBe(true);
		expect(report.builtinImportsInOutput).toEqual([]);
		expect(report.nodeGlobals).toEqual([]);
	}, 120_000);
});
