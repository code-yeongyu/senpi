import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrepEngine, GrepEngineRequest } from "../../src/core/tools/grep/engine.ts";
import { createRgEngine, type RgEngineOptions } from "../../src/core/tools/grep/rg-engine.ts";
import { buildCorpus } from "./fixtures/build-corpus.ts";

const MiB = 1024 * 1024;
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function describeEngineContract(name: string, makeEngine: () => Promise<GrepEngine> | GrepEngine): void {
	describe(`${name} GrepEngine contract`, () => {
		const cleanups: Array<() => Promise<void>> = [];
		afterEach(async () => {
			vi.useRealTimers();
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		});
		async function corpus(git = true): Promise<string> {
			const fixture = await buildCorpus({ git });
			cleanups.push(fixture.cleanup);
			return fixture.root;
		}
		async function tree(files: Record<string, string | Buffer>): Promise<string> {
			const root = await mkdtemp(join(tmpdir(), "grep-contract-"));
			cleanups.push(() => rm(root, { recursive: true, force: true }));
			for (const [path, content] of Object.entries(files)) {
				await mkdir(join(root, path, ".."), { recursive: true });
				await writeFile(join(root, path), content);
			}
			return root;
		}
		async function search(root: string, options: Partial<GrepEngineRequest> = {}) {
			return (await makeEngine()).search({ pattern: "needle", paths: [root], cwd: root, ...options });
		}
		function large(nul?: number): Buffer {
			const bytes = Buffer.alloc(5 * MiB, "a");
			bytes.write("needle\r\n", 100);
			bytes.write("needle\n", 4 * MiB + 100);
			if (nul !== undefined) bytes[nul] = 0;
			return bytes;
		}
		function trackSpawn() {
			const calls: string[][] = [];
			const children: ChildProcessWithoutNullStreams[] = [];
			const launch: NonNullable<RgEngineOptions["spawn"]> = (command, args, options) => {
				calls.push(args);
				const child = spawn(command, args, options);
				children.push(child);
				return child;
			};
			return { calls, children, launch };
		}

		it("exposes the selected engine name", async () => {
			expect((await makeEngine()).name).toBe(name);
		});
		it("overlap_missing_and_policy_roots", async () => {
			const root = await corpus();
			const paths = [join(root, "src"), join(root, "src/nested"), join(root, "missing")];
			const result = await search(root, { paths });
			expect(result.filesSearched).toBe(3);
			expect(result.counts).toEqual({ matches: 6, files: 3, exact: true });
			expect(result.missingPaths).toEqual([join(root, "missing")]);
			expect(result.matches.every((row) => row.path.startsWith("src/"))).toBe(true);
			await expect(search(root, { paths: [paths[2]] })).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
		});
		it("regex_recovery_preserves_semantics", async () => {
			const root = await tree({ "a.txt": "foo{bar}\nfoo(bar\nNEEDLE\npre-needle\nneedle\nend\n" });
			await expect(search(root, { pattern: "foo(bar" })).rejects.toMatchObject({ code: "INVALID_PATTERN" });
			const literal = await search(root, { pattern: "foo(bar", literal: true });
			expect(literal.matches.map((row) => row.line)).toEqual([2]);
			expect(literal.effectivePattern).toBe("foo(bar");
			expect(literal.patternKind).toBe("literal");
			expect((await search(root, { pattern: "^needle$", ignoreCase: true })).counts.matches).toBe(2);
			expect((await search(root, { pattern: "needle.end", multiline: true })).counts.matches).toBe(0);
			expect((await search(root, { pattern: "needle\\nend", multiline: true })).counts.matches).toBe(2);
		});
		it("glob_type_hidden_ignore_parity", async () => {
			const root = await corpus();
			const paths = (await search(root, { type: "ts", glob: ["!src/z.ts", "*.ts"] })).matches.map((row) => row.path);
			expect([...new Set(paths)]).toEqual([
				".hidden/h.ts",
				"lookaround.ts",
				"src/a.ts",
				"src/nested/deep/b.ts",
				"unicode.ts",
			]);
			const defaults = await search(root);
			expect(
				defaults.matches.some(
					(row) =>
						row.path.startsWith("ignored/") || row.path.startsWith("scratch/") || row.path.startsWith(".git/"),
				),
			).toBe(false);
			const visible = await search(root, { hidden: false, gitignore: false });
			expect(visible.matches.some((row) => row.path === "ignored/i.ts")).toBe(true);
			expect(visible.matches.some((row) => row.path === "scratch/s.ts")).toBe(true);
			expect(visible.matches.some((row) => row.path.startsWith(".hidden/"))).toBe(false);
			await expect(search(root, { type: "not-a-real-type" })).rejects.toMatchObject({ code: "UNKNOWN_TYPE" });
			await expect(search(root, { glob: ["["] })).rejects.toMatchObject({ code: "INVALID_GLOB" });
		});
		it("ordering_is_path_bytes_then_line", async () => {
			const root = await tree({
				"z.ts": "needle\nneedle\n",
				"ä.ts": "needle\n",
				"a.ts": "needle\nneedle\n",
				"B.ts": "needle\n",
			});
			const result = await search(root);
			expect(result.matches.map((row) => [row.path, row.line])).toEqual([
				["B.ts", 1],
				["a.ts", 1],
				["a.ts", 2],
				["z.ts", 1],
				["z.ts", 2],
				["ä.ts", 1],
			]);
			if (name === "rg") {
				const tracked = trackSpawn();
				await createRgEngine({ spawn: tracked.launch }).search({ pattern: "needle", paths: [root], cwd: root });
				for (const args of tracked.calls)
					expect(args.slice(args.indexOf("--sort"), args.indexOf("--sort") + 2)).toEqual(["--sort", "path"]);
			}
		});
		it("overlapping_roots_ordered_once", async () => {
			const root = await tree({ "src/z.ts": "needle\n", "src/nested/a.ts": "needle\n", "src/b.ts": "needle\n" });
			await symlink("src", join(root, "alias"));
			const result = await search(root, {
				paths: [join(root, "src/nested"), join(root, "src"), join(root, "alias")],
			});
			expect(result.matches.map((row) => row.path)).toEqual(["alias/b.ts", "alias/nested/a.ts", "alias/z.ts"]);
			expect(result.filesSearched).toBe(3);
		});
		it("files_searched_counts_all_candidates_including_binary", async () => {
			const root = await corpus();
			for (const mode of ["content", "count", "files"] as const) {
				const result = await search(root, { mode });
				expect(result.filesSearched).toBe(14);
				expect(result.skippedBinary).toBe(2);
			}
		});
		it("files_searched_is_sorted_prefix_under_cap", async () => {
			const root = await corpus();
			expect((await search(root, { maxCount: 3, maxCountPerFile: 1 })).filesSearched).toBe(5);
			// The satisfying file is inside a normal-size segment, not at its boundary.
			const small = await tree({ "a.ts": "needle\n", "b.ts": "needle\n", "z.ts": "needle\n" });
			for (const mode of ["content", "count", "files"] as const) {
				expect((await search(small, { mode, maxCount: 1 })).filesSearched).toBe(1);
			}
		});
		it("binary_nul_anywhere_skips_file_all_modes", async () => {
			const root = await corpus();
			for (const mode of ["content", "count", "files"] as const) {
				const result = await search(root, { paths: [join(root, "bin.dat"), join(root, "late-nul.bin")], mode });
				expect(result.matches).toEqual([]);
				expect(result.fileCounts).toEqual([]);
				expect(result.counts).toEqual({ matches: mode === "files" ? null : 0, files: 0, exact: true });
				expect(result.skippedBinary).toBe(2);
				expect(result.filesSearched).toBe(2);
			}
		});
		it("stdin_prefix_nul_skips_file", async () => {
			const root = await tree({
				"a-large.txt": large(3000000),
				"big-late-nul.txt": large(4500000),
				"no-line.txt": Buffer.alloc(5 * MiB, "a"),
			});
			for (const mode of ["content", "count", "files"] as const) {
				const result = await search(root, { mode });
				expect(result.skippedBinary).toBe(1);
				expect(result.prefixSearched).toBe(1);
				expect(result.skippedOversized).toBe(1);
				expect(result.counts).toEqual({ matches: mode === "files" ? null : 1, files: 1, exact: true });
				expect(mode === "content" ? result.matches[0].path : result.fileCounts[0].path).toBe("big-late-nul.txt");
			}
		});
		it("count_mode_counts_physical_lines", async () => {
			const root = await tree({ "a.ts": "needle\nend\nneedle\nend\n", "z.ts": "needle\nend\n" });
			const result = await search(root, { pattern: "needle\\nend", multiline: true, mode: "count" });
			expect(result.matches).toEqual([]);
			expect(result.fileCounts).toEqual([
				{ path: "a.ts", count: 4, limitReached: false },
				{ path: "z.ts", count: 2, limitReached: false },
			]);
			expect(result.counts).toEqual({ matches: 6, files: 2, exact: true });
			const files = await search(root, { pattern: "needle\\nend", multiline: true, mode: "files" });
			expect(files.counts).toEqual({ matches: null, files: 2, exact: true });
			expect(files.fileCounts).toEqual([
				{ path: "a.ts", count: null, limitReached: false },
				{ path: "z.ts", count: null, limitReached: false },
			]);
		});
		it("context_before_after_dedupe", async () => {
			const root = await tree({ "a.ts": "before\nneedle\nneedle\nafter\nlast\n" });
			const result = await search(root, { contextBefore: 1, contextAfter: 2 });
			expect(result.matches.map((row) => [row.line, row.isContext])).toEqual([
				[1, true],
				[2, false],
				[3, false],
				[4, true],
				[5, true],
			]);
			expect(result.counts.matches).toBe(2);
			const capped = await search(root, { contextBefore: 1, contextAfter: 1, maxCountPerFile: 1 });
			expect(capped.matches.filter((row) => !row.isContext).map((row) => row.line)).toEqual([2]);
			expect(capped.perFileLimitReached).toBe(true);
		});
		it("range_before_caps_and_scalar_truncation", async () => {
			const root = await tree({ "a.ts": "needle\nneedle\n界😀needle\nneedle\nneedle\n" });
			const result = await search(root, {
				paths: [join(root, "a.ts")],
				lineStart: 3,
				lineEnd: 4,
				maxCountPerFile: 1,
				maxColumns: 2,
			});
			expect(result.matches).toEqual([
				{ path: "a.ts", line: 3, column: 8, text: "界😀...", isContext: false, truncated: true },
			]);
			expect(result.perFileLimitReached).toBe(true);
			expect(result.counts.exact).toBe(false);
			const exact = await search(root, {
				paths: [join(root, "a.ts")],
				lineStart: 3,
				lineEnd: 3,
				maxCountPerFile: 1,
			});
			expect(exact.perFileLimitReached).toBe(false);
		});
		it("column_is_byte_based_first_line_only", async () => {
			const root = await tree({ "a.ts": "before\n界needle\nend\nafter\n" });
			const result = await search(root, {
				pattern: "needle\\nend",
				multiline: true,
				contextBefore: 1,
				contextAfter: 1,
			});
			expect(result.matches.map((row) => [row.line, row.column, row.isContext])).toEqual([
				[1, undefined, true],
				[2, 4, false],
				[3, undefined, false],
				[4, undefined, true],
			]);
		});
		it("lossy_utf8_text", async () => {
			const root = await corpus(false);
			const result = await search(root, { paths: [join(root, "latin1.txt")] });
			expect(result.matches).toEqual([
				{ path: "latin1.txt", line: 1, column: 3, text: "� needle", isContext: false, truncated: false },
			]);
			expect(result.skippedBinary).toBe(0);
		});
		it("no_require_git_parity", async () => {
			const root = await corpus(false);
			const result = await search(root);
			expect(result.matches.some((row) => row.path === ".hidden/h.ts")).toBe(true);
			expect(result.matches.some((row) => row.path.startsWith("ignored/") || row.path.startsWith("scratch/"))).toBe(
				false,
			);
		});
		it("unsupported_vs_invalid_pattern_classification", async () => {
			const root = await corpus(false);
			for (const pattern of ["(?<=pre-)needle", "(needle)\\1"])
				await expect(search(root, { pattern })).rejects.toMatchObject({ code: "UNSUPPORTED_REGEX" });
			await expect(search(root, { pattern: "[" })).rejects.toMatchObject({ code: "INVALID_PATTERN" });
			if (name === "rg") {
				const result = await search(root, { pattern: "(?<=pre-)needle", pcre2: true });
				expect(result.regexEngine).toBe("pcre2");
				expect(result.matches.map((row) => row.path)).toEqual(["lookaround.ts"]);
			}
		});
		it("nul_in_utf16_bytes_is_binary", async () => {
			const root = await tree({
				"utf16.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("needle\n", "utf16le")]),
			});
			for (const mode of ["content", "count", "files"] as const) {
				const result = await search(root, { mode });
				expect(result.skippedBinary).toBe(1);
				expect(result.counts.files).toBe(0);
			}
		});
		it("empty_candidates_still_validate_regex", async () => {
			const root = await tree({});
			await expect(search(root, { pattern: "[" })).rejects.toMatchObject({ code: "INVALID_PATTERN" });
			expect((await search(root)).counts).toEqual({ matches: 0, files: 0, exact: true });
		});
		it("glob_escaping_of_include_list", async () => {
			const root = await tree({
				"a[1]*.ts": "needle\n",
				"!bang?.ts": "needle\n",
				"d{e}/z.ts": "needle\n",
				"other.txt": "needle\n",
			});
			const result = await search(root, { type: "ts" });
			expect(result.matches.map((row) => row.path)).toEqual(["!bang?.ts", "a[1]*.ts", "d{e}/z.ts"]);
		});

		if (name === "rg") {
			it("oversized_lexical_first_wins_rg", async () => {
				const root = await tree({ "a-large": large(), "z-small": "needle\n" });
				const result = await search(root, { maxCount: 1 });
				expect(result.matches.map((row) => row.path)).toEqual(["a-large"]);
				expect(result.prefixSearched).toBe(1);
				expect(result.limitReached).toBe(true);
			});
			it("capped_search_stops_after_ordered_prefix", async () => {
				const files = Object.fromEntries(
					Array.from({ length: 500 }, (_, i) => [`${String(i).padStart(3, "0")}.ts`, "needle\n"]),
				);
				const root = await tree(files);
				const tracked = trackSpawn();
				const result = await createRgEngine({ spawn: tracked.launch }).search({
					pattern: "needle",
					paths: [root],
					cwd: root,
					maxCount: 1,
					glob: ["*.ts"],
				});
				expect(result.matches.map((row) => row.path)).toEqual(["000.ts"]);
				expect(result.filesSearched).toBe(1);
				const searches = tracked.calls.filter((args) => args.includes("--json"));
				expect(searches).toHaveLength(1);
				expect(searches[0].filter((arg) => arg.startsWith("/") && arg.endsWith(".ts"))).toHaveLength(200);
				expect(result.counts).toEqual({ matches: 1, files: 1, exact: false });
			});
			it("json_in_every_mode", async () => {
				const root = await tree({ "a.ts": "needle\nneedle\n", "z.ts": "needle\n" });
				for (const mode of ["content", "count", "files"] as const) {
					const tracked = trackSpawn();
					const result = await createRgEngine({ spawn: tracked.launch }).search({
						pattern: "needle",
						paths: [root],
						cwd: root,
						mode,
					});
					const args = tracked.calls.find((call) => call.includes("needle"));
					expect(args).toContain("--json");
					expect(args).not.toContain("-c");
					expect(args).not.toContain("-l");
					if (mode === "files")
						expect(args?.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "1"]);
					expect(result.counts).toEqual({ matches: mode === "files" ? null : 3, files: 2, exact: true });
				}
			});
			it("timeout_partial_prefix", async () => {
				const root = await tree(
					Object.fromEntries(
						Array.from({ length: 401 }, (_, i) => [`${String(i).padStart(3, "0")}.ts`, "needle\n"]),
					),
				);
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				let clock = 0;
				let segments = 0;
				const engine = createRgEngine({
					now: () => clock,
					spawn: (command, args, options) => {
						const child = spawn(command, args, options);
						if (args.includes("--json") && ++segments === 2)
							child.stdout.once("data", () => {
								clock = 101;
							});
						return child;
					},
				});
				const result = await engine.search({
					pattern: "needle",
					paths: [root],
					cwd: root,
					timeoutMs: 100,
					maxCount: 1000,
				});
				expect(segments).toBe(2);
				expect(result.matches).toHaveLength(200);
				expect(result.filesSearched).toBe(200);
				expect(result.matches.map((row) => row.path)).toEqual(
					Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")}.ts`).sort(byteOrder),
				);
				expect(result.timedOut).toBe(true);
				expect(result.counts.exact).toBe(false);
				expect(result.warnings.map((warning) => warning.code)).toContain("TIMED_OUT");
			});
			it("timeout_kills_and_awaits_child", async () => {
				const root = await tree({ "a.ts": "needle\n" });
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				let child: ChildProcessWithoutNullStreams | undefined;
				const engine = createRgEngine({
					now: () => 0,
					spawn: (command, args, options) => {
						if (!args.includes("--json")) return spawn(command, args, options);
						child = spawn(
							process.execPath,
							[
								"-e",
								'process.on("SIGTERM", () => process.exit(0)); process.stdin.resume(); process.stdout.write(JSON.stringify({type:"begin",data:{path:{text:"a.ts"}}})+"\\n");',
							],
							options,
						);
						child.stdout.once("data", () => vi.advanceTimersByTime(100));
						return child;
					},
				});
				try {
					const result = await engine.search({ pattern: "needle", paths: [root], cwd: root, timeoutMs: 100 });
					expect(result.timedOut).toBe(true);
					expect(result.matches).toEqual([]);
					expect(result.filesSearched).toBe(0);
					expect(child?.exitCode).toBe(0);
				} finally {
					if (child && child.exitCode === null && child.signalCode === null) {
						const closed = once(child, "close");
						child.kill("SIGKILL");
						await closed;
					}
				}
			});
			it("fallback_exit_bytes_abort_cleanup", async () => {
				const root = await tree({ "a.ts": "needle\n" });
				const request = { pattern: "needle", paths: [root], cwd: root };
				const fake = (script: string) =>
					createRgEngine({
						spawn: (command, args, options) =>
							args.includes("--json")
								? spawn(process.execPath, ["-e", script], options)
								: spawn(command, args, options),
					});
				for (const code of [0, 1])
					expect((await fake(`process.exit(${code})`).search(request)).counts.matches).toBe(0);
				await expect(
					fake('process.stderr.write("disk failure"); process.exit(2)').search(request),
				).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
				expect(
					(
						await fake(
							'process.stderr.write("No files were searched, which means ripgrep probably applied a filter you did not expect.\\nRunning with --debug will show why files are being skipped.\\n"); process.exit(2)',
						).search(request)
					).counts.matches,
				).toBe(0);
				await expect(fake('process.stdout.write("not json\\n")').search(request)).rejects.toMatchObject({
					code: "ENGINE_UNAVAILABLE",
				});
				const tracked = trackSpawn();
				await createRgEngine({ spawn: tracked.launch }).search({ ...request, pattern: "--pre=should-never-run" });
				const args = tracked.calls.find((call) => call.includes("--pre=should-never-run"));
				expect(args?.slice(args.indexOf("--") + 1)).toEqual(["--pre=should-never-run", await realpath(root)]);
				const controller = new AbortController();
				let child: ChildProcessWithoutNullStreams | undefined;
				const engine = createRgEngine({
					spawn: (command, args, options) => {
						if (!args.includes("--json")) return spawn(command, args, options);
						child = spawn(
							process.execPath,
							[
								"-e",
								'process.on("SIGTERM", () => process.exit(0)); process.stdin.resume(); process.stdout.write(JSON.stringify({type:"begin",data:{path:{text:"a.ts"}}})+"\\n");',
							],
							options,
						);
						child.stdout.once("data", () => controller.abort());
						return child;
					},
				});
				try {
					await expect(engine.search(request, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
					expect(child).toBeDefined();
					expect(child?.exitCode).not.toBeNull();
				} finally {
					if (child && child.exitCode === null && child.signalCode === null) {
						const closed = once(child, "close");
						child.kill("SIGKILL");
						await closed;
					}
				}
				await expect(engine.search(request, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
			});
		}
	});
}
