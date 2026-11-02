import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GrepEngineRequest } from "../../../src/core/tools/grep/engine.ts";
import { createRgEngine, type RgEngineOptions } from "../../../src/core/tools/grep/rg-engine.ts";

// #3516: the grep tool's second phase passes the selected files as explicit roots.
// Each explicit file used to cost three rg processes (--files, NUL scan, search), all
// spawned on the host loop. The rg launch count must not grow with the number of files.

const FILES = 20;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
}, 60_000);

async function corpus(): Promise<{ root: string; files: string[]; binary: string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "grep-3516-")));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const files: string[] = [];
	for (let index = 0; index < FILES; index++) {
		const dir = join(root, `d${String(index).padStart(2, "0")}`);
		await mkdir(dir);
		const file = join(dir, "f.ts");
		await writeFile(file, `first\nneedle ${index}\nmiddle\nneedle again ${index}\n`);
		files.push(file);
	}
	const binary = join(root, "d05", "blob.bin");
	await writeFile(binary, Buffer.from("needle\0binary\n"));
	return { root, files, binary };
}

function tracked() {
	const calls: string[][] = [];
	const launch: NonNullable<RgEngineOptions["spawn"]> = (command, args, options) => {
		calls.push(args);
		return spawn(command, args, options);
	};
	return { calls, engine: createRgEngine({ spawn: launch }) };
}

describe("#3516 rg engine batches explicit file roots", () => {
	it("searches N explicit files with a constant number of rg processes", async () => {
		const { root, files, binary } = await corpus();
		const { calls, engine } = tracked();
		const request: GrepEngineRequest = {
			pattern: "needle",
			paths: [...files, binary],
			cwd: root,
			mode: "content",
			maxCountPerFile: 21,
		};
		const result = await engine.search(request);

		expect(calls).toHaveLength(2);
		expect(result.counts).toEqual({ matches: FILES * 2, files: FILES, exact: true });
		expect(result.skippedBinary).toBe(1);
		expect(result.filesSearched).toBe(FILES + 1);
		expect(result.matches.map((row) => [row.path, row.line])).toEqual(
			files.flatMap((_, index) => {
				const path = `d${String(index).padStart(2, "0")}/f.ts`;
				return [
					[path, 2],
					[path, 4],
				];
			}),
		);
	});

	it("honors the ordered maxCount prefix across batched file roots", async () => {
		const { root, files } = await corpus();
		const { calls, engine } = tracked();
		const result = await engine.search({ pattern: "needle", paths: files, cwd: root, mode: "files", maxCount: 5 });

		expect(calls).toHaveLength(2);
		expect(result.fileCounts.map((file) => file.path)).toEqual([
			"d00/f.ts",
			"d01/f.ts",
			"d02/f.ts",
			"d03/f.ts",
			"d04/f.ts",
		]);
		expect(result.limitReached).toBe(true);
		expect(result.filesSearched).toBe(5);
	});

	it("grows capped directory batches so a sparse match costs logarithmic launches", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "grep-3516-sparse-")));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const total = 1700;
		await Promise.all(
			Array.from({ length: total }, (_, index) =>
				writeFile(join(root, `f${String(index).padStart(4, "0")}.txt`), index === total - 1 ? "needle\n" : "hay\n"),
			),
		);
		const { calls, engine } = tracked();
		const result = await engine.search({ pattern: "needle", paths: [root], cwd: root, mode: "files", maxCount: 1 });

		// 2 enumeration launches, then batches of 200, 200, 400, 800, 100 instead of 9 x 200.
		expect(calls).toHaveLength(7);
		expect(result.fileCounts.map((file) => file.path)).toEqual(["f1699.txt"]);
		expect(result.filesSearched).toBe(total);
		expect(result.limitReached).toBe(false);
	});

	it("keeps directory roots on their own filtered walk beside batched files", async () => {
		const { root, files } = await corpus();
		await mkdir(join(root, "tree"));
		await writeFile(join(root, "tree", "kept.ts"), "needle\n");
		await writeFile(join(root, "tree", "ignored.ts"), "needle\n");
		await writeFile(join(root, "explicit-ignored.ts"), "needle\n");
		await writeFile(join(root, ".gitignore"), "ignored.ts\nexplicit-ignored.ts\n");
		const { engine } = tracked();
		const result = await engine.search({
			pattern: "needle",
			paths: [join(root, "tree"), join(root, "explicit-ignored.ts"), files[0]],
			cwd: root,
			glob: ["!*.ts"],
		});

		// rg always searches an explicitly named file; a directory root stays filtered.
		expect([...new Set(result.matches.map((row) => row.path))]).toEqual(["d00/f.ts", "explicit-ignored.ts"]);
	});
});
