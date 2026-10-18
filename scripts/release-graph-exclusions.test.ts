import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const metadataSchema = z.object({
	outputs: z.record(z.string(), z.object({
		inputs: z.record(z.string(), z.object({ bytesInOutput: z.number() })),
	})),
});

test("excludes retired DOM dependencies when building the release entry graph", () => {
	// Given: actual release entrypoints, including any legacy worker still in the command.
	const repo = resolve(import.meta.dir, "..");
	const manifest = z.object({ scripts: z.object({ "build:binary": z.string() }) }).parse(
		JSON.parse(readFileSync(join(repo, "packages/coding-agent/package.json"), "utf8")),
	);
	const entries = manifest.scripts["build:binary"].split(" ").filter((arg) => /^\.\.?\/.*\.(?:ts|js)$/.test(arg));
	const scratch = mkdtempSync(join(tmpdir(), "senpi-release-exclusions-"));
	try {
		// When: Bun's optimized release bundle produces a real contribution metafile.
		const result = spawnSync(process.execPath, [
			"build", "--target=bun", "--splitting", "--minify", "--keep-names",
			`--metafile=${join(scratch, "meta.json")}`, ...entries, "--outdir", scratch,
		], { cwd: join(repo, "packages/coding-agent"), encoding: "utf8", timeout: 120_000 });
		expect(result.status, result.stderr).toBe(0);
		const metadata = metadataSchema.parse(JSON.parse(readFileSync(join(scratch, "meta.json"), "utf8")));
		// Then: parsed-but-tree-shaken modules do not count; only shipped bytes do.
		const retired = /\/node_modules\/(?:jsdom|css-tree|mdn-data|source-map-js|@mixmark-io\/domino)\//;
		const contributions = Object.values(metadata.outputs).flatMap((output) =>
			Object.entries(output.inputs).filter(([path, input]) => retired.test(path.replaceAll("\\", "/")) && input.bytesInOutput > 0),
		);
		expect(contributions).toEqual([]);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 130_000);
