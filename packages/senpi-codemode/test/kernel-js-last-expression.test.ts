import { describe, expect, it } from "vitest";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

describe("JavaScript kernel last-expression capture", () => {
	it("captures a parenthesized expression statement after a completed block", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "if (true) {}\n(42)");

			expect(parseJavaScriptResult(run.result)).toBe(42);
		});
	});

	it("echoes final declarations identically with and without trailing comments", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const uncommented = await runJavaScriptCell(kernel, "const captureFinalPlain = 9");
			const commented = await runJavaScriptCell(kernel, "const captureFinalCommented = 7 // note");

			expect(parseJavaScriptResult(uncommented.result)).toBe(9);
			expect(parseJavaScriptResult(commented.result)).toBe(7);
		});
	});

	it("keeps a division continuation split across lines as one statement", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "const captureDivBase = 8;\ncaptureDivBase /\n2");

			expect(parseJavaScriptResult(run.result)).toBe(4);
		});
	});

	it("keeps an await operand on the next line as one statement", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "await\nPromise.resolve(42)");

			expect(parseJavaScriptResult(run.result)).toBe(42);
		});
	});

	it("invokes tagged templates split across lines", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "const captureTag = () => 123;\ncaptureTag\n`raw`");

			expect(parseJavaScriptResult(run.result)).toBe(123);
		});
	});

	it("captures the last expression after a regex following a control condition", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, 'if (true) /[(]/.test("(")\n42');

			expect(parseJavaScriptResult(run.result)).toBe(42);
		});
	});

	it("runs labeled final statements without capturing them", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "captureLabel: { break captureLabel; }");

			expect(run.result.ok).toBe(true);
		});
	});
});
