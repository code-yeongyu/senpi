import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { createCoreEditTool } from "../../../src/core/tools/edit-core.ts";
import { defaultToolMachine } from "../../../src/core/tools/machine.ts";
import { createSyntaxChecker, type SyntaxChecker } from "../../../src/core/tools/syntax-check.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";
import { createCoreWriteTool } from "../../../src/core/tools/write-core.ts";

// senpi#7234: an edit or write that leaves a previously parseable file unparseable still succeeds, and its result
// carries one warning with the first syntax error's line and column. Vitest runs on Node, where only JSON has a
// parser; the JS/TS path through Bun.Transpiler is covered by the real-CLI QA.

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

function reportedPosition(text: string): { line: number; column: number } | undefined {
	const match = /First syntax error at (\d+):(\d+):/u.exec(text);
	return match ? { line: Number(match[1]), column: Number(match[2]) } : undefined;
}

const VALID_JSON = '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n';

function strictMessage(content: string): string {
	try {
		JSON.parse(content);
	} catch (error) {
		if (error instanceof SyntaxError) return error.message;
	}
	throw new Error(`expected a JSON syntax error for ${content}`);
}

/** The warning a write of `content` to a new .json file returns through the local write tool. */
async function newJsonWarning(content: string): Promise<string> {
	const dir = await tempDir();
	return resultText(await createWriteTool(dir).execute("call-1", { path: "new.json", content }));
}

describe("issue #7234: parse-break warning on edit and write", () => {
	it("edit that breaks a parseable JSON file applies and warns with the error position", async () => {
		const dir = await tempDir();
		const file = join(dir, "package.json");
		await writeFile(file, VALID_JSON);

		const result = await createEditTool(dir).execute("call-1", {
			path: "package.json",
			edits: [{ oldText: '"demo",', newText: '"demo"' }],
		});

		expect(result.isError).toBeFalsy();
		expect(await readFile(file, "utf8")).toBe('{\n  "name": "demo"\n  "version": "1.0.0"\n}\n');
		expect(reportedPosition(resultText(result))).toEqual({ line: 3, column: 3 });
	});

	it("valid edit and edit of an already unparseable file carry no warning", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "valid.json"), VALID_JSON);
		await writeFile(join(dir, "broken.json"), '{\n  "a": 1\n  "b": 2\n}\n');
		const edit = createEditTool(dir);

		const valid = await edit.execute("call-1", {
			path: "valid.json",
			edits: [{ oldText: "1.0.0", newText: "1.0.1" }],
		});
		const broken = await edit.execute("call-2", { path: "broken.json", edits: [{ oldText: "2", newText: "3" }] });

		expect(resultText(valid)).not.toContain("Warning");
		expect(resultText(broken)).not.toContain("Warning");
	});

	it("write that creates an unparseable JSON file warns; overwriting an unparseable file does not", async () => {
		const dir = await tempDir();
		const write = createWriteTool(dir);

		const created = await write.execute("call-1", { path: "new.json", content: '{\n  "a": 1,\n}\n' });
		const recreated = await write.execute("call-2", { path: "new.json", content: '{\n  "a": 2,\n}\n' });

		expect(created.isError).toBeFalsy();
		expect(await readFile(join(dir, "new.json"), "utf8")).toBe('{\n  "a": 2,\n}\n');
		expect(reportedPosition(resultText(created))).toEqual({ line: 3, column: 1 });
		expect(resultText(recreated)).not.toContain("Warning");
	});

	it("a checker or locator that throws leaves the write and edit results unchanged", async () => {
		const dir = await tempDir();
		const machine = defaultToolMachine();
		const throwingParser = createSyntaxChecker({
			parseScript: () => {
				throw new Error("parser unavailable");
			},
		});
		const throwingLocator: SyntaxChecker = {
			...createSyntaxChecker(),
			locate: () => {
				throw "locator unavailable";
			},
		};
		await writeFile(join(dir, "package.json"), VALID_JSON);

		const written = await createCoreWriteTool(dir, { machine, checkSyntax: throwingParser }).execute("call-1", {
			path: "new.ts",
			content: "let a = ;\n",
		});
		const edited = await createCoreEditTool(dir, { machine, checkSyntax: throwingLocator }).execute("call-2", {
			path: "package.json",
			edits: [{ oldText: '"demo",', newText: '"demo"' }],
		});

		expect(resultText(written)).toBe("Successfully wrote to new.ts");
		expect(await readFile(join(dir, "new.ts"), "utf8")).toBe("let a = ;\n");
		expect(resultText(edited)).toBe("Successfully replaced 1 block(s) in package.json.");
		expect(await readFile(join(dir, "package.json"), "utf8")).toContain('"demo"\n');
	});

	it("keeps the JSON.parse message and reports the offset where strict parsing fails", async () => {
		// Each position is where JSON.parse itself stops, not where a lenient parser would; the first input fails at
		// `x` (1:8) although its trailing comma is a second error, the second has no position in V8's message.
		const cases = [
			{ content: '{"a": 0x1, "b": 2,}', position: { line: 1, column: 8 } },
			{ content: "{'a': 1,}", position: { line: 1, column: 2 } },
			{ content: '{\n  "a": [1, {"b": "x\\q"}],\n}', position: { line: 2, column: 21 } },
			{ content: '{\n  "a": {"b": [1, 2,]}\n}', position: { line: 2, column: 20 } },
			{ content: '["\\u12x"]', position: { line: 1, column: 7 } },
			{ content: '{"a": 1', position: { line: 1, column: 8 } },
		];
		for (const { content, position } of cases) {
			const text = await newJsonWarning(content);
			expect(text, content).toContain(`: ${strictMessage(content)}.`);
			expect(reportedPosition(text), content).toEqual(position);
		}
	});

	it("never reads a position from the invalid input quoted in the JSON.parse message", async () => {
		for (const content of ["at position 200", "(line 9 column 9)"]) {
			expect(reportedPosition(await newJsonWarning(content)), content).toEqual({ line: 1, column: 1 });
		}
	});
});
