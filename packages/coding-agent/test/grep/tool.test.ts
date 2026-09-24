import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { GrepEngineError } from "../../src/core/tools/grep/engine.ts";
import { formatGrepContent } from "../../src/core/tools/grep/format.ts";
import * as selector from "../../src/core/tools/grep/select-engine.ts";
import { createGrepToolDefinition, type GrepToolInput } from "../../src/core/tools/grep.ts";
import { getTextOutput } from "../../src/core/tools/render-utils.ts";
import { buildCorpus } from "./fixtures/build-corpus.ts";

describe("grep facade", () => {
	let root: string;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "grep-tool-"));
		await Promise.all(
			Array.from({ length: 2500 }, (_, i) =>
				writeFile(
					join(root, `${String(i).padStart(4, "0")}.txt`),
					"before\nneedle one\nneedle two\nafter\nfoo{bar\na(b\npre-needle\n",
				),
			),
		);
	});
	afterAll(async () => rm(root, { recursive: true, force: true }));
	const run = (input: GrepToolInput) =>
		createGrepToolDefinition(root).execute("test", input, undefined, undefined, { cwd: root } as ExtensionContext);
	it("schema accepts every field", () => {
		expect(
			Value.Check(createGrepToolDefinition(root).parameters, {
				pattern: "needle",
				path: [root],
				glob: ["*.txt", "!0001.txt"],
				type: "txt",
				ignoreCase: true,
				literal: false,
				multiline: false,
				context: 1,
				before: 0,
				after: 2,
				mode: "count",
				limit: 2,
				skip: 1,
				timeoutMs: 30000,
				hidden: true,
				gitignore: false,
			}),
		).toBe(true);
	});
	it.each([
		[{ pattern: "" }, "Pattern must not be empty"],
		[{ pattern: "x", path: "" }, "path must be a non-empty string or array of non-empty strings"],
		[{ pattern: "x", path: [] }, "path must be a non-empty string or array of non-empty strings"],
		[{ pattern: "x", path: [""] }, "path must be a non-empty string or array of non-empty strings"],
		[{ pattern: "x", skip: -1 }, "skip must be a non-negative integer"],
		[{ pattern: "x", skip: 1.5 }, "skip must be a non-negative integer"],
		[{ pattern: "x", limit: 0 }, "limit must be a positive integer"],
		[{ pattern: "x", limit: 1.5 }, "limit must be a positive integer"],
	] as const)("validation %j", async (input, message) => {
		await expect(run(input as GrepToolInput)).rejects.toThrow(message);
	});
	it("policy deny before engine", async () => {
		const engine = await selector.resolveGrepEngine();
		const spy = vi.spyOn(engine, "search");
		try {
			const policy = vi.fn(async () => ({ allow: false as const, reason: "denied" }));
			await expect(
				createGrepToolDefinition(root, { filesystemPolicy: policy }).execute(
					"test",
					{
						pattern: "needle",
						path: [root],
					},
					undefined,
					undefined,
					{ cwd: root } as ExtensionContext,
				),
			).rejects.toThrow("denied");
			expect(spy).not.toHaveBeenCalled();
			expect(policy).toHaveBeenCalledWith({
				operation: "enumerate",
				canonicalPath: await realpath(root),
				toolName: "grep",
			});
		} finally {
			spy.mockRestore();
		}
	});
	it("selector happy/invalid and single file ignores skip", async () => {
		const result = await run({ pattern: "needle", path: "0000.txt:L2-L2", skip: 200 });
		expect(result.details?.matches.map((m) => m.line)).toEqual([2]);
		expect(result.details?.skip).toBe(0);
		expect(result.content).toEqual([
			{ type: "text", text: "0000.txt\n2: needle one\n" },
			{ type: "text", text: expect.stringMatching(/^\[grep: matches=1 files=1 searched=/), audience: "model" },
		]);
		expect(getTextOutput(result, false)).toBe("0000.txt\n2: needle one\n");
		await expect(run({ pattern: "needle", path: "0000.txt:L3-L2" })).rejects.toThrow("Invalid line selector");
		await expect(run({ pattern: "needle", path: "missing:L1-L2" })).rejects.toThrow("Path not found:");
	});
	it("multi-root missing paths", async () => {
		const result = await run({ pattern: "needle", path: ["missing", "0000.txt"] });
		expect(result.details?.paths).toEqual([join(root, "0000.txt")]);
		expect(result.details?.scan.missingPaths).toEqual([join(root, "missing")]);
		await expect(run({ pattern: "x", path: ["missing", "absent"] })).rejects.toThrow(
			`Path not found: ${join(root, "missing")}, ${join(root, "absent")}`,
		);
	});
	it("skip_beyond_2000_preselection", async () => {
		const result = await run({ pattern: "needle", skip: 2480 });
		expect(result.details?.fileMatches[0]?.path).toBe("2480.txt");
		expect(result.details?.fileCount).toBe(20);
		expect(result.details?.nextSkip).toBeNull();
	}, 60000);
	it("round_robin_limit_smaller_than_page", async () => {
		const result = await run({ pattern: "needle", limit: 2 });
		expect(result.details?.matches.map((m) => m.path)).toEqual(["0000.txt", "0001.txt"]);
		expect(result.details?.nextSkip).toBe(2);
	});
	it("details_matches_rendered_rows", async () => {
		const result = await run({ pattern: "needle", limit: 3, context: 1 });
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const rows = text.split("\n").filter((l) => /^\d+[:-] /.test(l));
		expect(rows).toEqual(result.details?.matches.map((m) => `${m.line}${m.isContext ? "-" : ":"} ${m.text}`));
		expect(result.details?.matchCount).toBe(3);
	});
	it("pcre2_delegation_note", async () => {
		const result = await run({ pattern: "(?<=pre-)needle", path: "0000.txt" });
		expect(result.details?.scan.regexEngine).toBe("pcre2");
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("Regex unsupported by the native engine; matched with ripgrep --pcre2."),
		});
	});
	it("brace_recovery_then_literal_fallback", async () => {
		const brace = await run({ pattern: "foo{bar", path: "0000.txt" });
		expect(brace.details?.scan.patternKind).toBe("sanitized");
		expect(brace.details?.scan.effectivePattern).toBe("foo\\{bar");
		const engine = await selector.resolveGrepEngine();
		const original = engine.search.bind(engine);
		const spy = vi
			.spyOn(engine, "search")
			.mockImplementation((request, signal) =>
				request.pattern === "a\\(b"
					? Promise.reject(new GrepEngineError("INVALID_PATTERN", "still invalid"))
					: original(request, signal),
			);
		try {
			const literal = await run({ pattern: "a(b", path: "0000.txt" });
			expect(spy.mock.calls.map((c) => [c[0].pattern, c[0].literal])).toEqual([
				["a(b", undefined],
				["a\\(b", undefined],
				["a(b", true],
			]);
			expect(literal.details?.scan.patternKind).toBe("literal");
		} finally {
			spy.mockRestore();
		}
	});
	it("text_footer_always_present", async () => {
		for (const mode of ["content", "count", "files"] as const) {
			const result = await run({ pattern: "absent", mode, path: "0000.txt" });
			expect(result.content[1]).toMatchObject({
				audience: "model",
				text: expect.stringMatching(
					/\[grep: matches=(0|n\/a) files=0 searched=\d+ elapsedMs=\d+ engine=(rg|native) nextSkip=none\]$/,
				),
			});
		}
	});
	it("no_match_and_page_end_messages", async () => {
		expect((await run({ pattern: "absent", path: "0000.txt" })).details?.status).toBe("noMatch");
		const result = await run({ pattern: "needle", glob: "000*.txt", skip: 20 });
		expect(result.details?.status).toBe("pageEnd");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("No more results (skip=20)") });
	});
	it.each(["count", "files"] as const)("count_files_mode_paging %s", async (mode) => {
		const result = await run({ pattern: "needle", mode, limit: 2, skip: 1 });
		expect(result.details?.fileMatches).toEqual([
			{ path: "0001.txt", count: mode === "files" ? null : 3 },
			{ path: "0002.txt", count: mode === "files" ? null : 3 },
		]);
		expect(result.details?.nextSkip).toBe(3);
		expect(result.details?.matchCount).toBe(mode === "files" ? null : 6);
	});
	it("preselected files are not filtered again relative to their parent", async () => {
		const corpus = await buildCorpus({ git: false });
		try {
			const result = await createGrepToolDefinition(corpus.root).execute(
				"glob",
				{ pattern: "needle", glob: "src/*.ts" },
				undefined,
				undefined,
				{ cwd: corpus.root } as ExtensionContext,
			);
			expect(result.details?.fileMatches).toEqual([
				{ path: "src/a.ts", count: 3 },
				{ path: "src/z.ts", count: 1 },
			]);
		} finally {
			await corpus.cleanup();
		}
	});
	it("explicit oversized roots inspect only the bounded prefix", async () => {
		const corpus = await buildCorpus({ git: false });
		try {
			const result = await run({ pattern: "needle", path: join(corpus.root, "big-late-nul.txt") });
			expect(result.details?.matchCount).toBe(1);
			expect(result.details?.scan.skippedBinary).toBe(0);
			expect(result.details?.scan.prefixSearched).toBe(1);
		} finally {
			await corpus.cleanup();
		}
	});
	it("caps preserve matching rows and injected elapsed duration", async () => {
		const file = join(root, "cap.txt");
		await writeFile(file, Array.from({ length: 205 }, () => "needle").join("\n"));
		try {
			const single = await run({ pattern: "needle", path: file, limit: 300 });
			expect(single.details?.matchCount).toBe(200);
			expect(single.details?.perFileLimitReached).toBe(true);
			const multi = await run({ pattern: "needle", glob: "cap.txt", limit: 300 });
			expect(multi.details?.matchCount).toBe(20);
			expect(multi.details?.perFileLimitReached).toBe(true);
			expect(formatGrepContent(single.details!, { now: () => 17 })[1].text).toContain("elapsedMs=17");
		} finally {
			await rm(file);
		}
	});
	it("literal selector-looking filenames take precedence", async () => {
		const path = join(root, "0000.txt:L2-L2");
		await writeFile(path, "needle\n");
		try {
			expect((await run({ pattern: "needle", path })).details?.matches.map((m) => m.line)).toEqual([1]);
		} finally {
			await rm(path);
		}
	});
	it("signal and explicit multiline defaults reach the engine", async () => {
		const engine = await selector.resolveGrepEngine();
		const spy = vi.spyOn(engine, "search");
		const controller = new AbortController();
		try {
			await createGrepToolDefinition(root).execute(
				"signal",
				{ pattern: "needle\\n", path: "0000.txt" },
				controller.signal,
				undefined,
				{ cwd: root } as ExtensionContext,
			);
			expect(spy.mock.calls[0][0]).toMatchObject({ multiline: true });
			expect(spy.mock.calls[0][1]).toBe(controller.signal);
			controller.abort();
			await expect(
				createGrepToolDefinition(root).execute(
					"abort",
					{ pattern: "needle", path: "0000.txt" },
					controller.signal,
					undefined,
					{ cwd: root } as ExtensionContext,
				),
			).rejects.toMatchObject({ code: "ABORTED" });
		} finally {
			spy.mockRestore();
		}
	});
	it("operations_option_rejected", () => {
		const options = { operations: { isDirectory: () => true, readFile: () => "" } };
		expect(() => createGrepToolDefinition(root, options as never)).toThrow(TypeError);
		expect(() => createGrepToolDefinition(root, options as never)).toThrow(/operations.*deprecated/i);
	});
});
