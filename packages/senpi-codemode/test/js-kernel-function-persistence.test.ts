import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

async function withKernel<T>(fn: (run: (code: string) => Promise<unknown>) => Promise<T>): Promise<T> {
	const kernel = new JavaScriptKernel({ sessionId: "fn-persistence", cwd: process.cwd(), parallelPoolWidth: 2 });
	const run = async (code: string): Promise<unknown> => {
		const result = await kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 5_000 });
		if (!result.ok) throw new Error(`cell failed: ${JSON.stringify(result)}`);
		return JSON.parse(result.valueRepr ?? "null");
	};
	try {
		return await fn(run);
	} finally {
		await kernel.close();
	}
}

describe("JavaScriptKernel top-level function declarations persist like var (senpi#3127)", () => {
	it.each([
		{ name: "a function", define: 'function probe() { return "FN_OK"; }', use: "return probe()", expected: "FN_OK" },
		{
			name: "an async function",
			define: 'async function probe() { return "ASYNC_OK"; }',
			use: "return await probe()",
			expected: "ASYNC_OK",
		},
		{
			name: "a generator",
			define: "function* probe() { yield 1; yield 2; }",
			use: "return [...probe()].join(',')",
			expected: "1,2",
		},
		{
			name: "a strict-mode cell",
			define: '"use strict";\nfunction probe() { return this === undefined; }',
			use: "return probe()",
			expected: true,
		},
		{
			name: "a cell that returns before the declaration",
			define: "return 1;\nfunction probe() { return 'HOISTED'; }",
			use: "return probe()",
			expected: "HOISTED",
		},
		{ name: "a constructor", define: "function Point(x) { this.x = x; }", use: "return new Point(3).x", expected: 3 },
	])("keeps $name for the next cell", async ({ define, use, expected }) => {
		await withKernel(async (run) => {
			await run(define);
			expect(await run(use)).toEqual(expected);
		});
	});

	it("keeps the declaration usable before its line in the defining cell and the var beside it", async () => {
		await withKernel(async (run) => {
			expect(
				await run(
					'const early = probe();\nfunction probe() { return "FN_OK"; }\nvar control = "VAR_OK";\nreturn [early, control];',
				),
			).toEqual(["FN_OK", "VAR_OK"]);
			expect(await run("return { fnType: typeof probe, varValue: control };")).toEqual({
				fnType: "function",
				varValue: "VAR_OK",
			});
		});
	});

	it("does not leak nested, block or string-only functions", async () => {
		await withKernel(async (run) => {
			await run(
				'function outer() { function inner() {} return typeof inner; }\nif (true) { function blockOnly() {} }\nconst text = "function fake() {}";\nreturn outer();',
			);
			expect(await run("return [typeof outer, typeof inner, typeof fake];")).toEqual([
				"function",
				"undefined",
				"undefined",
			]);
		});
	});
});
