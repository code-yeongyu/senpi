import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GrepEngineRequest, GrepEngineResult } from "../../../src/core/tools/grep/engine.ts";
import { matcherFlags, segmentFlags, walkerFlags } from "../../../src/core/tools/grep/rg/args.ts";
import { argvBudget, argvCost, commandLineOverflow, EXECUTABLE_RESERVE } from "../../../src/core/tools/grep/rg/argv.ts";
import {
	type Candidate,
	enumerateCandidates,
	type Root,
	resolveRoots,
} from "../../../src/core/tools/grep/rg/enumerate.ts";
import { planSegments } from "../../../src/core/tools/grep/rg/segments.ts";
import { createRgEngine } from "../../../src/core/tools/grep/rg-engine.ts";

const base = "/work/repo";
const platforms = ["win32", "darwin", "linux"] as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fileCandidate(index: number, name = "f.ts"): Candidate {
	const path = join(base, `d${String(index).padStart(4, "0")}`, name);
	const root: Root = { path, alias: path, cwd: join(path, ".."), file: true };
	return { absolute: path, canonical: path, display: path, root, size: 10, ordinal: index + 1, binary: false };
}

function treeCandidates(count: number, nameOf = (index: number) => `module "${index}".ts`): Candidate[] {
	const root: Root = { path: base, alias: base, cwd: base, file: false };
	return Array.from({ length: count }, (_, index) => {
		const absolute = join(base, "src dir", nameOf(index));
		return { absolute, canonical: absolute, display: absolute, root, size: 10, ordinal: index + 1, binary: false };
	});
}

function commandLine(argv: readonly string[], platform: NodeJS.Platform): number {
	return EXECUTABLE_RESERVE + argv.reduce((sum, argument) => sum + argvCost(argument, platform), 0);
}

function heavyRequest(): GrepEngineRequest {
	const glob = Array.from({ length: 60 }, (_, index) => `!**/generated-${index}/**/*.snapshot.ts`);
	return {
		pattern: Array.from({ length: 700 }, (_, index) => `ident${index}`).join("|"),
		paths: [base],
		cwd: base,
		glob,
	};
}

function awkwardName(seed: number): string {
	const parts = ['a\\"b', "c d", "\\\\", '"', "한글", "x".repeat(seed % 37), "e\\"];
	let state = seed * 2654435761;
	let name = "";
	for (let index = 0; index < 1 + (seed % 5); index++) {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		name += parts[state % parts.length];
	}
	return `${name}${seed}.ts`;
}

describe("#3516 rg launches fit the whole OS command line", () => {
	it("keeps the Windows budget under the 32,767-character command line", () => {
		expect(argvBudget("win32")).toBeLessThanOrEqual(32_767);
		expect(argvBudget("darwin")).toBeLessThan(1024 * 1024);
	});

	it("counts Windows quoting: quotes, escaped quotes and doubled backslash runs", () => {
		expect(argvCost("ab", "darwin")).toBe(3);
		expect(argvCost("a b", "win32")).toBe(6);
		expect(argvCost('a"b', "win32")).toBe(7);
		expect(argvCost("C:\\dir\\", "win32")).toBe("C:\\dir\\".length + 3 + 1);
		expect(argvCost('a\\\\"b c\\', "win32")).toBe('a\\\\"b c\\'.length + 3 + 1 + 2 + 1);
	});

	it("packs a quote-and-backslash-heavy batch exactly at the win32 limit and splits at limit - 1", () => {
		const request: GrepEngineRequest = { pattern: "needle", paths: [base], cwd: base };
		const files = [fileCandidate(0, 'a\\\\"b c\\'), fileCandidate(1, '\\"q\\" r\\\\')];
		const limit = commandLine(segmentFlags(files, "needle", [], []), "win32");
		const plan = (budget: number) =>
			planSegments(files, request, { walk: [], matcher: [], budget, platform: "win32" });

		expect(plan(limit)).toEqual([files]);
		expect(plan(limit - 1)).toEqual([[files[0]], [files[1]]]);
	});

	for (const platform of platforms) {
		it(`splits with a long pattern and many globs under the ${platform} budget`, () => {
			const request = heavyRequest();
			const walk = walkerFlags(request);
			const matcher = matcherFlags(request);
			const budget = argvBudget(platform);
			const scale = platform === "win32" ? 1 : 10;
			const files = Array.from({ length: 1500 * scale }, (_, index) => fileCandidate(index));
			for (const candidates of [treeCandidates(1000 * scale), files]) {
				const segments = planSegments(candidates, request, { walk, matcher, platform });

				expect(segments.length).toBeGreaterThan(1);
				expect(segments.flat()).toEqual(candidates);
				for (const segment of segments) {
					const argv = segmentFlags(segment, request.pattern, walk, matcher);
					expect(argv).toContain(request.pattern);
					expect(commandLine(argv, platform)).toBeLessThanOrEqual(budget);
				}
				// Each launch is filled close to the limit, not split needlessly.
				expect(commandLine(segmentFlags(segments[0], request.pattern, walk, matcher), platform)).toBeGreaterThan(
					budget - 400,
				);
			}
		});

		it(`never exceeds the ${platform} budget for awkward names across many budgets`, () => {
			const request: GrepEngineRequest = { pattern: 'need"le\\', paths: [base], cwd: base, glob: ["!*.md"] };
			const walk = walkerFlags(request);
			const matcher = matcherFlags(request);
			const files = Array.from({ length: 400 }, (_, index) => fileCandidate(index, awkwardName(index)));
			for (const candidates of [files, treeCandidates(400, awkwardName)]) {
				for (const budget of [5_000, 5_123, 7_777, 12_345, argvBudget(platform)]) {
					const segments = planSegments(candidates, request, { walk, matcher, budget, platform });

					expect(segments.flat()).toEqual(candidates);
					for (const segment of segments)
						expect(
							commandLine(segmentFlags(segment, request.pattern, walk, matcher), platform),
						).toBeLessThanOrEqual(budget);
				}
			}
		});
	}

	it("keeps every NUL-scan batch under the budget and scans each explicit file once", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "grep-3516-nul-")));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const paths: string[] = [];
		for (let index = 0; index < 60; index++) {
			const path = join(root, `dir ${index}`, `file "${index}".ts`);
			await mkdir(join(path, ".."));
			await writeFile(path, "needle\n");
			paths.push(path);
		}
		const request: GrepEngineRequest = { pattern: "needle", paths, cwd: root };
		const result = { missingPaths: [], skippedBinary: 0 } as unknown as GrepEngineResult;
		const roots = await resolveRoots(request, result);
		const scans: string[][] = [];
		const budget = EXECUTABLE_RESERVE + 2_000;
		await enumerateCandidates({
			roots,
			cwd: root,
			walk: [],
			run: async (args) => {
				scans.push(args);
				return Buffer.alloc(0);
			},
			check: () => {},
			result,
			budget,
		});

		expect(scans.length).toBeGreaterThan(1);
		for (const args of scans) expect(commandLine(args, process.platform)).toBeLessThanOrEqual(budget);
		expect(scans.flatMap((args) => args.slice(args.indexOf("--") + 1))).toEqual(roots.map((entry) => entry.path));
	});

	it("rejects a pattern no launch can carry before spawning anything", async () => {
		const calls: string[][] = [];
		const engine = createRgEngine({
			spawn: (command, args, options) => {
				calls.push(args);
				return spawn(command, args, options);
			},
		});
		const pattern = "a|".repeat(argvBudget() / 2 + 10);

		await expect(engine.search({ pattern, paths: [tmpdir()], cwd: tmpdir() })).rejects.toMatchObject({
			code: "INVALID_PATTERN",
			message: expect.stringContaining("too long"),
		});
		expect(calls).toEqual([]);
	});

	it("names the platform limit an argument list would break", () => {
		expect(commandLineOverflow(["x".repeat(30_000)], "win32")).toContain("32000-character limit on win32");
		expect(commandLineOverflow(["x".repeat(131_072)], "linux")).toContain("per-argument limit");
		expect(commandLineOverflow(["x".repeat(131_071)], "linux")).toBeUndefined();
		expect(commandLineOverflow(["x".repeat(131_072)], "darwin")).toBeUndefined();
	});

	it("gives an argument that cannot share a launch its own launch instead of truncating it", () => {
		const long = fileCandidate(1, `${"x".repeat(400)}.ts`);
		const files = [fileCandidate(0), long, fileCandidate(2)];
		const request: GrepEngineRequest = { pattern: "needle", paths: [base], cwd: base };
		const budget = commandLine(segmentFlags([files[0]], "needle", [], []), "darwin") + 100;
		const segments = planSegments(files, request, { walk: [], matcher: [], budget, platform: "darwin" });

		expect(segments).toEqual([[files[0]], [long], [files[2]]]);
		expect(segmentFlags([long], "needle", [], []).at(-1)).toBe(long.root.path);
	});
});
