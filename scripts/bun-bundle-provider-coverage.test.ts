import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const repo = resolve(import.meta.dir, "..");
const cwd = join(repo, "packages/coding-agent");
const scratch = mkdtempSync(join(tmpdir(), "senpi-provider-coverage-"));
const metadataSchema = z.object({
	inputs: z.record(z.string(), z.unknown()),
	outputs: z.record(z.string(), z.object({
		entryPoint: z.string().optional(),
		inputs: z.record(z.string(), z.object({ bytesInOutput: z.number() })),
		imports: z.array(z.object({ path: z.string(), external: z.boolean().optional() })),
	})),
});
let metadata: z.infer<typeof metadataSchema>;
const normalized = (path: string): string => path.replaceAll("\\", "/");

beforeAll(() => {
	// Given: the same three entries and optimization flags as the release build, without --compile.
	const result = spawnSync(process.execPath, [
		"build", "--target=bun", "--splitting", "--minify", "--keep-names", `--metafile=${join(scratch, "metafile.json")}`,
		"./dist/bun/cli.js", "./src/modes/rpc/session-worker.ts", "./src/utils/image-resize-worker.ts",
		"--outdir", scratch,
	], { cwd, encoding: "utf8", timeout: 120_000 });
	expect(result.status, result.stderr).toBe(0);
	metadata = metadataSchema.parse(JSON.parse(readFileSync(join(scratch, "metafile.json"), "utf8")));
}, 130_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const provider of ["bedrock-converse-stream", "cursor-agent", "devin-agent"]) {
	test(`${provider} contributes implementation bytes reachable from both runtime isolates`, () => {
		// When: traverse the output-chunk imports for each independently loaded entry.
		const implementation = new RegExp(`/api/${provider}\\.(ts|js)$`);
		const inputs = Object.keys(metadata.inputs).filter((id) => implementation.test(normalized(id)));
		// Then: a parsed-but-tree-shaken input or a launcher-only registration cannot pass.
		expect(inputs.length).toBeGreaterThan(0);
		for (const entry of [/\/bun\/cli\.(ts|js)$/, /\/rpc\/session-worker\.(ts|js)$/]) {
			const root = Object.entries(metadata.outputs).find(([, output]) => entry.test(normalized(output.entryPoint ?? "")));
			expect(root).toBeDefined();
			if (!root) throw new Error("Missing runtime entry output");
			const pending = [root[0]];
			const visited = new Set<string>();
			let bytes = 0;
			while (pending.length > 0) {
				const path = pending.pop();
				if (path === undefined || visited.has(path)) continue;
				visited.add(path);
				const output = metadata.outputs[path];
				if (!output) throw new Error(`Missing output chunk: ${path}`);
				bytes += Object.entries(output.inputs).reduce((sum, [id, contribution]) =>
					sum + (implementation.test(normalized(id)) ? contribution.bytesInOutput : 0), 0);
				for (const imported of output.imports.filter((item) => !item.external)) {
					const target = Object.keys(metadata.outputs).find((candidate) =>
						normalized(resolve(cwd, candidate)) === normalized(resolve(cwd, imported.path)) ||
						normalized(resolve(cwd, candidate)) === normalized(resolve(cwd, dirname(path), imported.path)));
					if (!target) throw new Error(`Unresolved output import: ${imported.path}`);
					pending.push(target);
				}
			}
			expect(bytes, `${provider} from ${root[1].entryPoint}`).toBeGreaterThan(0);
		}
	});
}
