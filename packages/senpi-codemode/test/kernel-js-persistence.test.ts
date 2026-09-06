import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

describe("JavaScript kernel declaration persistence", () => {
	it("persists simple top-level declarations across cells", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(kernel, "const persistenceConst = 1; let persistenceLet = 2; var persistenceVar = 3;");

			const run = await runJavaScriptCell(kernel, "return [persistenceConst, persistenceLet, persistenceVar]");

			expect(parseJavaScriptResult(run.result)).toEqual([1, 2, 3]);
		});
	});

	it("persists object destructuring bindings, renames, defaults, and rest", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(
				kernel,
				"const persistenceObjectSource = { a: 1, b: 2, c: undefined, d: 4 }; const { a /* preserved */, b: bb, c = 3, ...rest } = persistenceObjectSource;",
			);

			const run = await runJavaScriptCell(kernel, "return [a, bb, c, rest]");

			expect(parseJavaScriptResult(run.result)).toEqual([1, 2, 3, { d: 4 }]);
		});
	});

	it("persists array destructuring bindings, holes, and rest", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(
				kernel,
				"const persistenceArraySource = [10, 20, 30, 40]; const [first, , third, ...tail] = persistenceArraySource;",
			);

			const run = await runJavaScriptCell(kernel, "return [first, third, tail]");

			expect(parseJavaScriptResult(run.result)).toEqual([10, 30, [40]]);
		});
	});

	it("persists declarations without initializers as undefined", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(kernel, "let persistenceUninitializedLet; var persistenceUninitializedVar;");

			const run = await runJavaScriptCell(
				kernel,
				"return [typeof persistenceUninitializedLet, persistenceUninitializedLet, typeof persistenceUninitializedVar, persistenceUninitializedVar]",
			);

			expect(parseJavaScriptResult(run.result)).toEqual(["undefined", null, "undefined", null]);
		});
	});

	it("does not rewrite or leak declarations in nested functions, blocks, or loop headers", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				`function persistenceNestedFunction() {
		  const persistenceFunctionScoped = 1;
		  return persistenceFunctionScoped;
		}
		if (true) {
		  let persistenceIfScoped = 2;
		  void persistenceIfScoped;
		}
		for (let persistenceForScoped = 0; persistenceForScoped < 1; persistenceForScoped += 1) {}
		for (const persistenceOfScoped of [1]) void persistenceOfScoped;
		for (const persistenceInScoped in { key: 1 }) void persistenceInScoped;
		return [
		  persistenceNestedFunction(),
		  typeof globalThis.persistenceFunctionScoped,
		  typeof globalThis.persistenceIfScoped,
		  typeof globalThis.persistenceForScoped,
		  typeof globalThis.persistenceOfScoped,
		  typeof globalThis.persistenceInScoped,
		];`,
			);

			expect(parseJavaScriptResult(run.result)).toEqual([
				1,
				"undefined",
				"undefined",
				"undefined",
				"undefined",
				"undefined",
			]);
		});
	});

	it("preserves literal and comment contents through the transform", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-js-persistence-"));
		try {
			await withJavaScriptKernel(
				async (kernel) => {
					const stringRun = await runJavaScriptCell(
						kernel,
						`// const persistenceLineCommentFake = 1;
/*
let persistenceBlockCommentFake = 2;
*/
const persistenceString = "before\\
const persistenceStringFake = 1;\\
after";
return [persistenceString, typeof globalThis.persistenceLineCommentFake, typeof globalThis.persistenceBlockCommentFake]`,
					);
					expect(parseJavaScriptResult(stringRun.result)).toEqual([
						"beforeconst persistenceStringFake = 1;after",
						"undefined",
						"undefined",
					]);

					const content =
						"header\nconst persistenceFileFake = 1;\n// let persistenceLineCommentFake = 2;\nvar persistenceNestedTemplateFake = 4;\n/*\nvar persistenceBlockCommentFake = 3;\n*/\nfooter";
					await runJavaScriptCell(
						kernel,
						`await write("persistence.txt", \`header
const persistenceFileFake = 1;
\${"// let persistenceLineCommentFake = 2;"}
\${\`var persistenceNestedTemplateFake = 4;\`}
/*
var persistenceBlockCommentFake = 3;
*/
footer\`)`,
					);
					const fileRun = await runJavaScriptCell(kernel, 'return await read("persistence.txt")');
					expect(parseJavaScriptResult(fileRun.result)).toBe(content);

					await runJavaScriptCell(
						kernel,
						[
							'await write("nested-template.txt", `outer',
							"const persistenceNestedTemplateFake = 4;",
							"${`inner",
							"let persistenceNestedTemplateExpressionFake = 5;",
							"`}",
							"after`)",
						].join("\\n"),
					);
					const nestedTemplateRun = await runJavaScriptCell(kernel, 'return await read("nested-template.txt")');

					expect(parseJavaScriptResult(nestedTemplateRun.result)).toBe(
						"outer\nconst persistenceNestedTemplateFake = 4;\ninner\nlet persistenceNestedTemplateExpressionFake = 5;\n\nafter",
					);
				},
				{ cwd },
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("supports top-level await and top-level return", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const awaited = await runJavaScriptCell(
				kernel,
				"const persistenceAwaited = await Promise.resolve(41) // preserved trailing comment\nreturn persistenceAwaited + 1",
			);
			const returned = await runJavaScriptCell(kernel, 'return "persistence-return"');

			expect(parseJavaScriptResult(awaited.result)).toBe(42);
			expect(parseJavaScriptResult(returned.result)).toBe("persistence-return");
		});
	});

	it("captures the last expression after persisted declarations", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				"const persistenceExpressionBase = 41\npersistenceExpressionBase + 1",
			);

			expect(parseJavaScriptResult(run.result)).toBe(42);
		});
	});

	it("allows the same declaration to be run again in a later cell", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(kernel, "const persistenceRerun = 1");
			await runJavaScriptCell(kernel, "const persistenceRerun = 2");

			const run = await runJavaScriptCell(kernel, "return persistenceRerun");

			expect(parseJavaScriptResult(run.result)).toBe(2);
		});
	});

	it("persists object-literal declarations containing interior line comments", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const first = await runJavaScriptCell(
				kernel,
				`const persistenceCommentedObject = {
		  // interior comment
		  value: 41,
		}
		return persistenceCommentedObject.value`,
			);
			const second = await runJavaScriptCell(kernel, "return persistenceCommentedObject.value + 1");

			expect(parseJavaScriptResult(first.result)).toBe(41);
			expect(parseJavaScriptResult(second.result)).toBe(42);
		});
	});

	it("persists arrow-function declarations containing interior comments", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const first = await runJavaScriptCell(
				kernel,
				`const persistenceCommentedArrow = () => {
		  // helper note
		  return 20
		}
		return persistenceCommentedArrow() + 1`,
			);
			const second = await runJavaScriptCell(kernel, "return persistenceCommentedArrow() + 2");

			expect(parseJavaScriptResult(first.result)).toBe(21);
			expect(parseJavaScriptResult(second.result)).toBe(22);
		});
	});

	it("evaluates initializers with trailing comments exactly once", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(kernel, "var persistenceEvalCount = 0");
			const declared = await runJavaScriptCell(
				kernel,
				"const persistenceCountedValue = (persistenceEvalCount += 1) // trailing note\nreturn persistenceCountedValue",
			);
			const counted = await runJavaScriptCell(kernel, "return persistenceEvalCount");

			expect(parseJavaScriptResult(declared.result)).toBe(1);
			expect(parseJavaScriptResult(counted.result)).toBe(1);
		});
	});

	it("persists destructured bindings declared with trailing comments", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(
				kernel,
				"const { persistenceCommentedA, renamed: persistenceCommentedB } = { persistenceCommentedA: 1, renamed: 2 } // note",
			);
			const run = await runJavaScriptCell(kernel, "return [persistenceCommentedA, persistenceCommentedB]");

			expect(parseJavaScriptResult(run.result)).toEqual([1, 2]);
		});
	});

	it("persists multi-declarator declarations containing block comments", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(
				kernel,
				"const persistenceMultiFirst = 1, persistenceMultiSecond = { /* block */ value: 2 }",
			);
			const run = await runJavaScriptCell(kernel, "return [persistenceMultiFirst, persistenceMultiSecond.value]");

			expect(parseJavaScriptResult(run.result)).toEqual([1, 2]);
		});
	});

	it("runs cells whose final statement is an else clause on its own line", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const first = await runJavaScriptCell(
				kernel,
				[
					"var persistenceBranchValue = 0",
					"if (persistenceBranchValue) { persistenceBranchValue = 1 }",
					"else persistenceBranchValue = 2",
				].join("\n"),
			);
			const run = await runJavaScriptCell(kernel, "return persistenceBranchValue");

			expect(first.result.ok).toBe(true);
			expect(parseJavaScriptResult(run.result)).toBe(2);
		});
	});

	it("keeps continuation-line method chains inside the captured last statement", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				[
					'var persistenceChained = "a-b"',
					'persistenceChained = persistenceChained.replace("a", "x")',
					'.replace(/b|\\(/g, "y")',
					"persistenceChained",
				].join("\n"),
			);

			expect(parseJavaScriptResult(run.result)).toBe("x-y");
		});
	});

	it("persists bindings whose pattern carries an interior line comment", async () => {
		await withJavaScriptKernel(async (kernel) => {
			await runJavaScriptCell(
				kernel,
				"const { persistenceCommentedBinding // note\n} = { persistenceCommentedBinding: 7 };",
			);
			const run = await runJavaScriptCell(kernel, "return persistenceCommentedBinding");

			expect(parseJavaScriptResult(run.result)).toBe(7);
		});
	});

	it("emits destructuring assignments that cannot merge with the previous expression statement", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				[
					"var persistenceAsiPrev = [0]",
					"persistenceAsiPrev.pop()",
					"const { length: persistenceAsiLen } = []",
					"persistenceAsiLen",
				].join("\n"),
			);

			expect(parseJavaScriptResult(run.result)).toBe(0);
		});
	});

	it("rejects declarations with a dangling trailing comma", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(kernel, "const persistenceDangling = 1,");

			expect(run.result.ok).toBe(false);
		});
	});

	it("captures the last expression after nested template literals in interpolations", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				[
					"var persistenceQuoted = `$" + '{"x".replace("x", `)`)}`',
					'var persistenceJoined = ["a", persistenceQuoted].join(',
					'\t"-",',
					")",
					"persistenceJoined",
				].join("\n"),
			);

			expect(parseJavaScriptResult(run.result)).toBe("a-)");
		});
	});
});
