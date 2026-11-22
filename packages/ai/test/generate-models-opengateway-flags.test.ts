import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

// readGeneratorOptions runs when the module loads, so a refused combination exits before any fetch. Should a
// combination slip through, the fetch preload and the temporary JSON output keep the run off the network and
// away from the committed catalog.
function runGenerator(args: string[]) {
	const root = mkdtempSync(join(tmpdir(), "pi-generate-models-flags-"));
	temporaryRoots.push(root);
	const preload = join(root, "no-network.mjs");
	writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("network disabled in this test"); };\n');
	return spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preload).href,
			"scripts/generate-models.ts",
			...args.map((arg) => arg.replace("<out>", join(root, "out"))),
		],
		{ cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
	);
}

describe("--keep-last-good-opengateway argument checks (senpi#4067)", () => {
	it.each([
		[
			["--keep-last-good-opengateway", "--json-only", "--json-output", "<out>"],
			/--keep-last-good-opengateway requires --strict/,
		],
		[
			["--strict", "--providers", "opengateway", "--keep-last-good-opengateway"],
			/--keep-last-good-opengateway cannot be combined with --providers/,
		],
	])("refuses %j", (args, message) => {
		const result = runGenerator(args);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(message);
	});
});
