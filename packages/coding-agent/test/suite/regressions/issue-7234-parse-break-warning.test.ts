import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";

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
});
