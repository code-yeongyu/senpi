import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { GrepEngineRequest, GrepEngineResult } from "../../src/core/tools/grep/engine.ts";
import { getNativeGrepCandidatePaths } from "../../src/core/tools/grep/native-loader.ts";
import { createRgEngine } from "../../src/core/tools/grep/rg-engine.ts";
import { resetGrepEngineForTests, resolveGrepEngine } from "../../src/core/tools/grep/select-engine.ts";
import { createGrepToolDefinition, type GrepToolDetails, type GrepToolInput } from "../../src/core/tools/grep.ts";
import { buildCorpus } from "./fixtures/build-corpus.ts";

const hasAddon = Boolean(process.env.SENPI_GREP_NATIVE_PATH) || getNativeGrepCandidatePaths().some(existsSync);

if (hasAddon) {
	describe("native/rg corpus parity", () => {
		let fixture: Awaited<ReturnType<typeof buildCorpus>>;
		const rg = createRgEngine();
		beforeAll(async () => {
			fixture = await buildCorpus();
		});
		afterAll(async () => fixture?.cleanup());
		function normalize({ elapsedMs: _, regexEngine: __, ...result }: GrepEngineResult) {
			return result;
		}
		const shapes: Array<[string, (root: string) => Partial<GrepEngineRequest>]> = [
			["content", () => ({ maxColumns: 500 })],
			["count", () => ({ mode: "count" })],
			["files", () => ({ mode: "files" })],
			["glob/type/policy", () => ({ glob: ["*.ts", "!src/z.ts"], type: "ts", hidden: false, gitignore: false })],
			["multiline", () => ({ pattern: "needle\\n", multiline: true, type: "ts" })],
			["context", (root) => ({ paths: [join(root, "src")], contextBefore: 1, contextAfter: 2 })],
			["caps", () => ({ maxCount: 3, maxCountPerFile: 1 })],
			[
				"single-file line range",
				(root) => ({ paths: [join(root, "src/nested/deep/b.ts")], lineStart: 5, lineEnd: 10, maxCountPerFile: 1 }),
			],
		];
		const toolShapes: GrepToolInput[] = [
			{ pattern: "needle" },
			{ pattern: "needle", mode: "count" },
			{ pattern: "needle", mode: "files" },
			{ pattern: "needle", glob: ["*.ts", "!src/z.ts"], type: "ts", hidden: false, gitignore: false },
			{ pattern: "needle\\n", type: "ts" },
			{ pattern: "needle", path: "src", before: 1, after: 2 },
			{ pattern: "needle", limit: 2, skip: 1 },
			{ pattern: "needle", path: "src/nested/deep/b.ts:L5-L10", context: 1 },
			{ pattern: "foo{bar", path: "braces.ts" },
			{ pattern: "(?<=pre-)needle", path: "lookaround.ts" },
		];
		function normalizeTool(result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails }) {
			const { engine: _, scan, ...details } = result.details!;
			const { elapsedMs: __, regexEngine: ___, ...stableScan } = scan;
			return {
				text: result.content
					.map((c) => c.text ?? "")
					.join("")
					.replace(/elapsedMs=\d+/, "elapsedMs=N")
					.replace(/engine=\w+/, "engine=X"),
				details: { ...details, scan: stableScan },
			};
		}
		it.each(toolShapes)("tool parity %j", async (input) => {
			const saved = process.env.SENPI_GREP_ENGINE;
			try {
				const results = [];
				for (const engine of ["rg", "native"]) {
					process.env.SENPI_GREP_ENGINE = engine;
					resetGrepEngineForTests();
					results.push(
						normalizeTool(
							await createGrepToolDefinition(fixture.root).execute("parity", input, undefined, undefined, {
								cwd: fixture.root,
							} as ExtensionContext),
						),
					);
				}
				expect(results[1]).toEqual(results[0]);
			} finally {
				if (saved === undefined) delete process.env.SENPI_GREP_ENGINE;
				else process.env.SENPI_GREP_ENGINE = saved;
				resetGrepEngineForTests();
			}
		});
		it.each(shapes)("%s", async (_name, options) => {
			const native = await resolveGrepEngine({ env: { ...process.env, SENPI_GREP_ENGINE: "native" } });
			const request = { pattern: "needle", paths: [fixture.root], cwd: fixture.root, ...options(fixture.root) };
			expect(normalize(await native.search(request))).toEqual(normalize(await rg.search(request)));
		});
	});
} else {
	it("requires a native fixture when native parity is explicitly requested", () => {
		expect(process.env.SENPI_GREP_ENGINE).not.toBe("native");
	});
}
