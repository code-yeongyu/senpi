import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSyntaxChecker } from "../../../src/core/tools/bun-syntax-check.ts";
import { createCoreEditTool } from "../../../src/core/tools/edit-core.ts";
import { defaultToolMachine } from "../../../src/core/tools/machine.ts";
import {
	createSyntaxChecker,
	parseBreakWarning,
	type ScriptParser,
	type SyntaxChecker,
} from "../../../src/core/tools/syntax-check.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";
import { createCoreWriteTool } from "../../../src/core/tools/write-core.ts";

// senpi#7234, second review: the advisory boundary covers every field a checker returns, positions count CR, CRLF
// and LF as one line break each, explicit module extensions are parsed without JSX, and the Bun parser's error shapes
// (several errors at once, a stack overflow, byte offsets) are read correctly. Vitest runs on Node, so the Bun
// parser is driven through a fake `Bun` object handed to createLocalSyntaxChecker.

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-7234-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

function reportedPosition(text: string | undefined): string | undefined {
	return /First syntax error at (\d+:\d+):/u.exec(text ?? "")?.[1];
}

/** The `line:column` V8 appends to its JSON.parse message. */
function v8Position(content: string): string | undefined {
	try {
		JSON.parse(content);
	} catch (error) {
		if (error instanceof SyntaxError) return /\(line (\d+) column (\d+)\)$/u.exec(error.message)?.slice(1).join(":");
	}
	return undefined;
}

function buildMessage(message: string, position: { line: number; column: number; offset: number }): Error {
	return Object.assign(new Error(message), { name: "BuildMessage", position });
}

/** A `Bun` stand-in whose Transpiler#scan throws what `fail` returns for the code, or nothing. */
function fakeBun(fail: (code: string) => unknown): object {
	class Transpiler {
		scan(code: string): void {
			const error = fail(code);
			if (error !== undefined) throw error;
		}
	}
	return { Transpiler };
}

describe("issue #7234: parse-break warning boundaries", () => {
	it("a checker result whose fields throw leaves the write and edit results unchanged", async () => {
		const machine = defaultToolMachine();
		const throwingResults: SyntaxChecker[] = [
			{
				...createSyntaxChecker(),
				locate: () => ({
					get message(): string {
						throw new Error("message unavailable");
					},
				}),
			},
			{
				...createSyntaxChecker(),
				locate: () => ({
					message: "broken",
					get line(): number {
						throw "line unavailable";
					},
				}),
			},
		];
		for (const checkSyntax of throwingResults) {
			const dir = await tempDir();
			await writeFile(join(dir, "package.json"), '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');

			const written = await createCoreWriteTool(dir, { machine, checkSyntax }).execute("call-1", {
				path: "new.json",
				content: "{",
			});
			const edited = await createCoreEditTool(dir, { machine, checkSyntax }).execute("call-2", {
				path: "package.json",
				edits: [{ oldText: '"demo",', newText: '"demo"' }],
			});

			expect(resultText(written)).toBe("Successfully wrote to new.json");
			expect(await readFile(join(dir, "new.json"), "utf8")).toBe("{");
			expect(resultText(edited)).toBe("Successfully replaced 1 block(s) in package.json.");
			expect(await readFile(join(dir, "package.json"), "utf8")).toContain('"demo"\n');
		}
	});

	it("a position that is not a positive integer line and column is left out", () => {
		const checker: SyntaxChecker = {
			...createSyntaxChecker(),
			locate: () => ({ message: "broken", line: -1, column: 1.5 }),
		};

		const warning = parseBreakWarning(checker, "a.json", undefined, "{");

		expect(warning).toContain("First syntax error: broken.");
	});

	it("JSON positions count a lone CR, CRLF and LF as one line break each, as the runtime does", async () => {
		const dir = await tempDir();
		const write = createWriteTool(dir);
		const contents = ['{\r  "a": 1,\r}', '{\r\n  "a": 1,\r\n}', '{\r\n  "a": 1,\r  "b": 2,\n}'];
		for (const [index, content] of contents.entries()) {
			const text = resultText(await write.execute("call-1", { path: `breaks-${index}.json`, content }));
			expect(reportedPosition(text), JSON.stringify(content)).toBe(v8Position(content));
		}
	});

	it("a leading BOM is not a syntax error, and positions are counted after it", async () => {
		const dir = await tempDir();
		const write = createWriteTool(dir);

		const valid = await write.execute("call-1", { path: "bom.json", content: '\uFEFF{"a": 1}' });
		const broken = await write.execute("call-2", { path: "bom-broken.json", content: '\uFEFF{"a": 1,}' });

		expect(resultText(valid)).toBe("Successfully wrote to bom.json");
		expect(reportedPosition(resultText(broken))).toBe("1:9");
	});

	it("explicit module extensions are parsed without JSX; .js and .jsx keep it", () => {
		const loaders = new Map<string, string>();
		const recordLoader: ScriptParser = (code, loader) => {
			loaders.set(code, loader);
			return { ok: true };
		};
		const checker = createSyntaxChecker({ parseScript: recordLoader });
		for (const extension of ["js", "jsx", "mjs", "cjs", "ts", "mts", "cts", "tsx"])
			checker.check(`a.${extension}`, extension);

		expect(Object.fromEntries(loaders)).toEqual({
			js: "jsx",
			jsx: "jsx",
			mjs: "js",
			cjs: "js",
			ts: "ts",
			mts: "ts",
			cts: "ts",
			tsx: "tsx",
		});
	});

	it("JSX added to an .mjs file gets the warning", () => {
		const rejectJsxInPlainJs: ScriptParser = (code, loader) =>
			loader !== "jsx" && code.includes("<")
				? { ok: false, error: { message: "Unexpected <", line: 1, column: 18 } }
				: { ok: true };
		const checker = createSyntaxChecker({ parseScript: rejectJsxInPlainJs });

		const warning = parseBreakWarning(checker, "main.mjs", "export const x = 1;\n", "export const x = <div/>;\n");

		expect(reportedPosition(warning)).toBe("1:18");
	});

	it("reads the Bun parser's error shapes: several errors, a stack overflow, byte offsets and lone CRs", () => {
		const first = buildMessage('Expected ";" but found ":"', { line: 1, column: 15, offset: 14 });
		const several = createLocalSyntaxChecker(
			fakeBun(
				() =>
					new AggregateError([first, buildMessage("second", { line: 1, column: 14, offset: 13 })], "Parse error"),
			),
		);
		const overflow = createLocalSyntaxChecker(
			fakeBun(() => buildMessage("Maximum call stack size exceeded", { line: 1, column: 4724, offset: 4723 })),
		);
		// Bun's offset counts UTF-8 bytes; its column after a lone CR is one short (2:8 for `let b = ;`).
		const nonAscii = "const s = 'é€😀';\nlet b = ;\n";
		const loneCr = "let a = 1;\rlet b = ;\r";
		// An end-of-file error: Bun puts it at the end of the last line, its offset lies after the final line break.
		const unclosed = "function f() {\n\treturn 1;\n";
		const positioned = createLocalSyntaxChecker(
			fakeBun((code) =>
				code === nonAscii
					? buildMessage("Unexpected ;", { line: 2, column: 9, offset: 31 })
					: code === loneCr
						? buildMessage("Unexpected ;", { line: 2, column: 8, offset: 19 })
						: code === unclosed
							? buildMessage("Unexpected end of file", { line: 2, column: 11, offset: 26 })
							: undefined,
			),
		);

		const severalWarning = parseBreakWarning(several, "a.js", undefined, "export const x: number = 1;\n");
		expect(severalWarning).toContain('First syntax error at 1:15: Expected ";" but found ":".');
		expect(parseBreakWarning(overflow, "a.ts", undefined, "let a = ((1));")).toBeUndefined();
		expect(reportedPosition(parseBreakWarning(positioned, "a.ts", undefined, nonAscii))).toBe("2:9");
		expect(reportedPosition(parseBreakWarning(positioned, "a.ts", undefined, loneCr))).toBe("2:9");
		expect(reportedPosition(parseBreakWarning(positioned, "a.ts", undefined, unclosed))).toBe("2:11");
	});
});
