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

	it("captures the last expression when a nested function contains return", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				"const captureNestedReturn = (() => { return 1; })();\ncaptureNestedReturn + 41",
			);

			expect(parseJavaScriptResult(run.result)).toBe(42);
		});
	});

	it("captures the last expression after a try/catch helper that returns", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				[
					"const captureHelperReturn = async () => { try { return await Promise.resolve(21); } catch (error) { return -1; } };",
					"(await captureHelperReturn()) * 2",
				].join("\n"),
			);

			expect(parseJavaScriptResult(run.result)).toBe(42);
		});
	});

	it("captures the last expression when return appears only inside a string or comment", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				'const captureReturnWord = "return"; // return here\ncaptureReturnWord.length',
			);

			expect(parseJavaScriptResult(run.result)).toBe(6);
		});
	});

	it("treats a property named return as a plain member access", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				'const captureReturnProperty = { return: 1 };\ncaptureReturnProperty.return\n"ok"',
			);

			expect(parseJavaScriptResult(run.result)).toBe("ok");
		});
	});

	// senpi#7381: a block holding `await using` followed by a statement on the same line was wrapped as `return { ... }`.
	it("runs a block with await using followed by a statement on the same line", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				'var usingEvents = []; { await using x = { async [Symbol.asyncDispose]() { usingEvents.push("closed"); } }; usingEvents.push("used"); } usingEvents',
			);

			expect(parseJavaScriptResult(run.result)).toEqual(["used", "closed"]);
		});
	});

	it("runs a cell that is one block statement holding a using declaration", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const block = await runJavaScriptCell(
				kernel,
				'globalThis.usingBlock = []; { using x = { [Symbol.dispose]() { usingBlock.push("closed"); } }; usingBlock.push("used"); }',
			);
			const after = await runJavaScriptCell(kernel, "usingBlock");

			expect(block.result.ok).toBe(true);
			expect(parseJavaScriptResult(after.result)).toEqual(["used", "closed"]);
		});
	});

	it("disposes bare top-level using declarations when the cell ends and keeps using as a name", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const bare = await runJavaScriptCell(
				kernel,
				[
					"globalThis.bareUsing = [];",
					'using syncRes = { [Symbol.dispose]() { bareUsing.push("sync"); } }',
					'await using asyncRes = { async [Symbol.asyncDispose]() { bareUsing.push("async"); } }',
				].join("\n"),
			);
			const after = await runJavaScriptCell(kernel, "bareUsing");
			const name = await runJavaScriptCell(kernel, "const using = 40;\nusing + 2");

			expect(bare.result.ok).toBe(true);
			expect(parseJavaScriptResult(after.result)).toEqual(["async", "sync"]);
			expect(parseJavaScriptResult(name.result)).toBe(42);
		});
	});

	it("keeps a genuine top-level return as the cell value", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "if (true) return 42;\n0");

			expect(parseJavaScriptResult(run.result)).toBe(42);
		});
	});

	it("suppresses capture for a top-level return even when that return does not fire", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, 'if (false) return 1;\n"tail"');

			expect(parseJavaScriptResult(run.result)).toBeUndefined();
		});
	});
});
