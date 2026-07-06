import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ToolNameViolation = {
	readonly file: string;
	readonly line: number;
	readonly name: string;
};

const sourceRoots = [
	fileURLToPath(new URL("../../src/core/tools/", import.meta.url)),
	fileURLToPath(new URL("../../src/core/extensions/builtin/", import.meta.url)),
] as const;
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const PASCAL_CASE_TOOL_NAME =
	/(?:^|[^\w])name\s*:\s*["']([A-Z][A-Za-z0-9_]*)["']|registerTool\s*\(\s*["']([A-Z][A-Za-z0-9_]*)["']/g;

function lineNumberAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (source.charCodeAt(i) === 10) line++;
	}
	return line;
}

function findPascalCaseToolNames(file: string, source: string): ToolNameViolation[] {
	const violations: ToolNameViolation[] = [];
	for (const match of source.matchAll(PASCAL_CASE_TOOL_NAME)) {
		const name = match[1] ?? match[2];
		if (!name) continue;
		violations.push({ file, line: lineNumberAt(source, match.index), name });
	}
	return violations;
}

async function collectTypeScriptFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTypeScriptFiles(path)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

async function findSourceViolations(): Promise<ToolNameViolation[]> {
	const files = (await Promise.all(sourceRoots.map(collectTypeScriptFiles))).flat();
	const violations: ToolNameViolation[] = [];
	for (const file of files) {
		const source = await readFile(file, "utf-8");
		violations.push(...findPascalCaseToolNames(relative(packageRoot, file), source));
	}
	return violations;
}

describe("tool name convention", () => {
	it("keeps senpi-defined tool names snake_case", async () => {
		const violations = await findSourceViolations();
		expect(violations).toEqual([]);
	});

	it("detects PascalCase tool names while ignoring provider-fixed hook event names", () => {
		const source = `
pi.registerTool({
	name: "BadTool",
	description: "fixture"
});
pi.registerTool("AlsoBad");
const providerFixed = { hook_event_name: "PreToolUse" };
pi.registerTool({
	name: "still_open
`;
		expect(findPascalCaseToolNames("fixture.ts", source)).toEqual([
			{ file: "fixture.ts", line: 3, name: "BadTool" },
			{ file: "fixture.ts", line: 6, name: "AlsoBad" },
		]);
	});
});
