import { describe, expect, it, vi } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

// senpi#7381: `jsCells.typescript` runs TypeScript cells with their types erased in place.
describe("JavaScript kernel TypeScript cells", () => {
	it("runs a TypeScript cell and keeps its top-level bindings for later cells", async () => {
		await withJavaScriptKernel(
			async (kernel) => {
				const first = await runJavaScriptCell(
					kernel,
					[
						"type Row = { id: number; label?: string };",
						"interface Named { readonly name: string }",
						"const rows: Row[] = [{ id: 1 }, { id: 2 }] satisfies Row[];",
						"function total<T extends Row>(items: readonly T[]): number { return items.reduce((sum, row) => sum + row.id, 0); }",
						"class Box<T> implements Named { public readonly name: string = 'box'; private value?: T; }",
						"total(rows) + new Box<number>().name.length",
					].join("\n"),
				);
				const later = await runJavaScriptCell(kernel, "rows.map((row: { id: number }) => row.id * 10)");

				expect(parseJavaScriptResult(first.result)).toBe(6);
				expect(parseJavaScriptResult(later.result)).toEqual([10, 20]);
			},
			{ typescriptCells: true },
		);
	});

	it("never reinterprets valid JavaScript as TypeScript", async () => {
		await withJavaScriptKernel(
			async (kernel) => {
				const run = await runJavaScriptCell(kernel, "const a = 1, b = 2, c = 3;\na < b > (c)");

				expect(parseJavaScriptResult(run.result)).toBe(false);
			},
			{ typescriptCells: true },
		);
	});

	it("refuses TypeScript that generates runtime code, naming the construct and its position", async () => {
		await withJavaScriptKernel(
			async (kernel) => {
				const run = await runJavaScriptCell(kernel, "const ok = 1;\nenum Color { Red }");

				expect(run.result.ok).toBe(false);
				if (run.result.ok) return;
				expect(run.result.error.message).toContain("TypeScript enum at line 2, column 1");
			},
			{ typescriptCells: true },
		);
	});

	it("leaves TypeScript a syntax error when jsCells.typescript is off", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "const typed: number = 1;\ntyped");

			expect(run.result.ok).toBe(false);
			if (run.result.ok) return;
			expect(run.result.error.code).toBe("js_cell_parse_error");
		});
	});

	it("locates a syntax error in a TypeScript cell at its own line and column", async () => {
		await withJavaScriptKernel(
			async (kernel) => {
				const tool = createEvalTool({
					enabledLanguages: { js: true, py: false, rb: false, jl: false },
					kernelManager: { getKernel: async () => kernel },
					cellTimeoutSeconds: 30,
					executeTool: vi.fn(),
					settings: { ...defaultCodemodeSettings, jsCells: { typescript: true } },
				});
				const failed = await tool.execute(
					crypto.randomUUID(),
					{ language: "js", code: "const first: number = 1;\nconst broken = (first +;", summary: "ts diagnostic" },
					undefined,
					undefined,
					fakeExtensionContext(),
				);

				expect(failed.details.isError).toBe(true);
				expect(failed.content[0]).toMatchObject({ text: expect.stringContaining("JS cell line 2, column 24:") });
			},
			{ typescriptCells: true },
		);
	});
});
