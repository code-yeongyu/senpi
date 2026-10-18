import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GrepEngineRequest, GrepEngineResult } from "../../../src/core/tools/grep/engine.ts";
import { createRgEngine } from "../../../src/core/tools/grep/rg-engine.ts";

// #3516: batching must not change any result. `batchBudget: 1` forces one rg launch
// per file (the pre-#3516 launch shape); the default and a mid-size budget batch.
// The whole result object, every field except elapsed time, must be identical.

const posix = process.platform !== "win32";
let root = "";
let explicit: string[] = [];

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "grep-3516-eq-")));
	const names = [
		"has space.ts",
		'quote"d.ts',
		"-leading.ts",
		"glob[*]{a,b}?.ts",
		"한글 파일.ts",
		".hidden.ts",
		"ignored.ts",
		"notes.md",
		"bin.dat",
		...(posix ? ["new\nline.ts", "back\\slash\\.ts", "C:\\Windows\\style.ts"] : []),
	];
	for (const [index, name] of names.entries()) {
		const dir = join(root, `n${String(index).padStart(2, "0")}`);
		await mkdir(dir);
		const body =
			name === "bin.dat" ? Buffer.from("needle\0") : `Needle ${index}\nctx\nneedle again ${index}\nneedle 3\n`;
		await writeFile(join(dir, name), body);
		explicit.push(join(dir, name));
	}
	await mkdir(join(root, "tree", ".hide"), { recursive: true });
	for (let index = 0; index < 12; index++) await writeFile(join(root, "tree", `t${index}.ts`), `needle ${index}\n`);
	await writeFile(join(root, "tree", ".hide", "h.ts"), "needle hidden\n");
	await writeFile(join(root, ".gitignore"), "ignored.ts\ntree/t3.ts\n");
	explicit = [...explicit, explicit[0]];
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const options: Array<[string, Partial<GrepEngineRequest>]> = [
	["content", {}],
	["glob excludes", { glob: ["!*.md", "!**/t1*"] }],
	["glob includes", { glob: ["*.ts"] }],
	["no hidden", { hidden: false }],
	["no ignore files", { gitignore: false }],
	["type filter", { type: "ts" }],
	["max count across batches", { maxCount: 7 }],
	["files mode max count", { mode: "files", maxCount: 9 }],
	["count mode", { mode: "count" }],
	["per-file cap", { maxCountPerFile: 1 }],
	["context", { contextBefore: 1, contextAfter: 1 }],
	["ignore case literal", { ignoreCase: true, literal: true, pattern: "needle 3" }],
];

async function run(budget: number | undefined, request: GrepEngineRequest): Promise<[GrepEngineResult, number]> {
	let launches = 0;
	const engine = createRgEngine({
		batchBudget: budget,
		spawn: (command, args, spawnOptions) => {
			launches++;
			return spawn(command, args, spawnOptions);
		},
	});
	const { elapsedMs: _elapsed, ...result } = await engine.search(request);
	return [{ ...result, elapsedMs: 0 }, launches];
}

describe("#3516 batched rg launches return exactly the per-file results", () => {
	for (const [label, option] of options)
		it(label, async () => {
			for (const paths of [explicit, [join(root, "tree"), ...explicit.slice(0, 5)]]) {
				const request: GrepEngineRequest = { pattern: "needle", paths, cwd: root, ...option };
				const [perFile, perFileLaunches] = await run(1, request);
				const [batched, batchedLaunches] = await run(undefined, request);
				const [mid] = await run(6_000, request);

				expect(batched).toEqual(perFile);
				expect(mid).toEqual(perFile);
				expect(batchedLaunches).toBeLessThan(perFileLaunches);
			}
		});
});
