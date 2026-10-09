import { beforeAll, expect, test } from "bun:test";
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

const repo = resolve(import.meta.dir, "..");

beforeAll(() => {
	// Direct invocation must not trust dist left by another branch or script suite.
	const build = spawnSync("node", ["scripts/build-all.mjs", "--pm", "bun"], {
		cwd: repo, encoding: "utf8", timeout: 300_000,
	});
	expect(build.status, `node scripts/build-all.mjs --pm bun\n${build.stdout}\n${build.stderr}`).toBe(0);
	const assets = spawnSync("node", ["scripts/prepare-bun-compile-assets.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 30_000,
	});
	expect(assets.status, assets.stderr).toBe(0);
}, 340_000);

test("ships no codemode implementation bytes when building the release entry graph", () => {
	// Given: the actual release entrypoints, freshly built by this suite.
	const manifest = z.object({ scripts: z.object({ "build:binary": z.string() }) }).parse(
		JSON.parse(readFileSync(join(repo, "packages/coding-agent/package.json"), "utf8")),
	);
	const entries = manifest.scripts["build:binary"].split(" ").filter((arg) => /^\.\.?\/.*\.(?:ts|js)$/.test(arg));
	const scratch = mkdtempSync(join(tmpdir(), "senpi-release-codemode-"));
	try {
		// When: Bun produces an optimized release contribution metafile.
		const result = spawnSync(process.execPath, [
			"build", "--target=bun", "--splitting", "--minify", "--keep-names",
			`--metafile=${join(scratch, "meta.json")}`, ...entries, "--outdir", scratch,
		], { cwd: join(repo, "packages/coding-agent"), encoding: "utf8", timeout: 120_000 });
		expect(result.status, result.stderr).toBe(0);
		const metadata = metadataSchema.parse(JSON.parse(readFileSync(join(scratch, "meta.json"), "utf8")));
		// Then: neither staged nor workspace-resolved codemode contributes shipped bytes.
		const codemode = /\/(?:node_modules\/@code-yeongyu\/senpi-codemode|packages\/senpi-codemode)\//;
		const contributions = Object.values(metadata.outputs).flatMap((output) =>
			Object.entries(output.inputs).filter(([path, input]) => codemode.test(resolve(repo, "packages/coding-agent", path).replaceAll("\\", "/")) && input.bytesInOutput > 0),
		);
		expect(contributions).toEqual([]);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 130_000);
