import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";
import type { AgentToolResult } from "../../types.js";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../../types.js";

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description: "The entire contents of the apply_patch command",
	}),
});

type ParsedPatch =
	| { type: "add"; filePath: string; content: string }
	| { type: "delete"; filePath: string }
	| { type: "update"; filePath: string; movePath?: string; chunks: PatchChunk[] };

type PatchChunk = {
	changeContexts: string[];
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

type BaselineState = {
	nonGptToolNames: string[];
};

export type FreeformToolFormat = {
	type: "grammar";
	syntax: "lark";
	definition: string;
};

type ApplyPatchToolDefinition = ToolDefinition<typeof APPLY_PATCH_PARAMS> & {
	freeform: FreeformToolFormat;
};

export type ApplyPatchExtensionAPI = Pick<ExtensionAPI, "on" | "getActiveTools" | "setActiveTools"> & {
	registerTool: (tool: ApplyPatchToolDefinition) => void;
};

type ApplyPatchParams = {
	input: string;
};

function normalizeApplyPatchArguments(args: unknown): ApplyPatchParams {
	if (typeof args === "string") {
		return { input: args };
	}

	if (args && typeof args === "object" && "input" in args) {
		const input = (args as { input?: unknown }).input;
		if (typeof input === "string") {
			return { input };
		}
	}

	return { input: "" };
}

const EDIT_TOOL_NAMES = new Set(["write", "edit"]);
export const APPLY_PATCH_FREEFORM_DESCRIPTION =
	"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const CODEX_APPLY_PATCH_DESCRIPTION =
	'Use the `apply_patch` tool to edit files.\nYour patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:\n\n*** Begin Patch\n[ one or more file sections ]\n*** End Patch\n\nWithin that envelope, you get a sequence of file operations.\nYou MUST include a header to specify the action you are taking.\nEach operation starts with one of three headers:\n\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\n*** Delete File: <path> - remove an existing file. Nothing follows.\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\n\nMay be immediately followed by *** Move to: <new path> if you want to rename the file.\nThen one or more “hunks”, each introduced by @@ (optionally followed by a hunk header).\nWithin a hunk each line starts with:\n\nFor instructions on [context_before] and [context_after]:\n- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change’s [context_after] lines in the second change’s [context_before] lines.\n- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:\n@@ class BaseClass\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\n- If a code block is repeated so many times in a class or function such that even a single `@@` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple `@@` statements to jump to the right context. For instance:\n\n@@ class BaseClass\n@@ \t def method():\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\nThe full grammar definition is below:\nPatch := Begin { FileOp } End\nBegin := "*** Begin Patch" NEWLINE\nEnd := "*** End Patch" NEWLINE\nFileOp := AddFile | DeleteFile | UpdateFile\nAddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }\nDeleteFile := "*** Delete File: " path NEWLINE\nUpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }\nMoveTo := "*** Move to: " newPath NEWLINE\nHunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]\nHunkLine := (" " | "-" | "+") text NEWLINE\n\nA full patch can combine several operations:\n\n*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n\nIt is important to remember:\n\n- You must include a header with your intended action (Add/Delete/Update)\n- You must prefix new lines with `+` even when creating a new file\n- File references can only be relative, NEVER ABSOLUTE.\n';

// Providers that route through OpenAI's GPT-* model family. Each one expects the
// codex-style apply_patch freeform tool to replace native edit/write calls.
// `openai` covers api.openai.com direct, `azure-openai-responses` covers Azure
// hosted GPT-5.x, and `github-copilot` covers Copilot's GPT proxy.
const GPT_PROVIDERS: ReadonlySet<string> = new Set(["openai", "azure-openai-responses", "github-copilot"]);

export function isOpenAIGptModel(model: Pick<Model<string>, "provider" | "id"> | undefined): boolean {
	return model !== undefined && GPT_PROVIDERS.has(model.provider) && model.id.startsWith("gpt-");
}

function normalizePatchText(patchText: string): string {
	return patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2] ?? input;
	}
	return input;
}

function normalizeSeekLine(line: string): string {
	return line
		.trim()
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
	if (pattern.length === 0) {
		return start;
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const lastStart = lines.length - pattern.length;
	const matches = (index: number, compare: (left: string, right: string) => boolean): boolean => {
		for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
			const line = lines[index + patternIndex];
			const expected = pattern[patternIndex];
			if (line === undefined || expected === undefined || !compare(line, expected)) {
				return false;
			}
		}
		return true;
	};

	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line === expected)) {
			return index;
		}
	}
	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line.trimEnd() === expected.trimEnd())) {
			return index;
		}
	}
	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line.trim() === expected.trim())) {
			return index;
		}
	}
	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => normalizeSeekLine(line) === normalizeSeekLine(expected))) {
			return index;
		}
	}

	return undefined;
}

export function extractPatchedPaths(patchText: string): string[] {
	const normalized = stripHeredoc(normalizePatchText(patchText));
	const matches = normalized.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm);
	return Array.from(matches, (match) => match[1] ?? "");
}

function trimDiff(diff: string): string {
	const lines = diff.split("\n");
	const contentLines = lines.filter(
		(line) =>
			(line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
			!line.startsWith("---") &&
			!line.startsWith("+++"),
	);
	if (contentLines.length === 0) {
		return diff;
	}

	let minIndent = Number.POSITIVE_INFINITY;
	for (const line of contentLines) {
		const content = line.slice(1);
		if (content.trim().length > 0) {
			minIndent = Math.min(minIndent, content.match(/^(\s*)/)?.[1]?.length ?? 0);
		}
	}
	if (minIndent === Number.POSITIVE_INFINITY || minIndent === 0) {
		return diff;
	}

	return lines
		.map((line) => {
			if (
				(line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
				!line.startsWith("---") &&
				!line.startsWith("+++")
			) {
				return `${line[0] ?? ""}${line.slice(1 + minIndent)}`;
			}
			return line;
		})
		.join("\n");
}

function createPatchDiff(oldPath: string, newPath: string, oldContent: string, newContent: string): string {
	return trimDiff(createTwoFilesPatch(oldPath, newPath, oldContent, newContent).trimEnd());
}

async function readExistingFileForPreview(absolutePath: string): Promise<string> {
	try {
		return await readFile(absolutePath, "utf-8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

function formatPendingPatchPaths(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) {
		return "Applying patch...";
	}
	return `Applying patch...\n${paths.map((filePath) => `• ${filePath}`).join("\n")}`;
}

async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<string> {
	const diffs: string[] = [];
	for (const hunk of hunks) {
		const absolutePath = await resolveWorkspacePath(cwd, hunk.filePath);
		if (hunk.type === "add") {
			const oldContent = await readExistingFileForPreview(absolutePath);
			diffs.push(createPatchDiff(hunk.filePath, hunk.filePath, oldContent, hunk.content));
			continue;
		}

		if (hunk.type === "delete") {
			const oldContent = await readFile(absolutePath, "utf-8");
			diffs.push(createPatchDiff(hunk.filePath, hunk.filePath, oldContent, ""));
			continue;
		}

		const oldContent = await readFile(absolutePath, "utf-8");
		const newContent = hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks);
		if (hunk.movePath) {
			await resolveWorkspacePath(cwd, hunk.movePath);
		}
		diffs.push(createPatchDiff(hunk.filePath, hunk.movePath ?? hunk.filePath, oldContent, newContent));
	}
	return diffs.filter((diff) => diff.trim().length > 0).join("\n");
}

function parsePatch(patchText: string): ParsedPatch[] {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
	const lines = normalized.split("\n");
	const beginIndex = lines[0]?.trim() === "*** Begin Patch" ? 0 : -1;
	const lastLine = lines[lines.length - 1];
	const endIndex = lastLine?.trim() === "*** End Patch" ? lines.length - 1 : -1;

	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
		throw new Error("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
	}

	const hunks: ParsedPatch[] = [];
	let index = beginIndex + 1;
	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (!line.startsWith("*** ")) {
			index++;
			continue;
		}

		if (line.startsWith("*** Add File: ")) {
			const filePath = line.slice("*** Add File: ".length);
			index++;
			const contentLines: string[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.startsWith("*** ")) {
					break;
				}
				if (!nextLine.startsWith("+")) {
					throw new Error(`Invalid patch format: Add File lines must start with '+'`);
				}
				contentLines.push(nextLine.slice(1));
				index++;
			}
			hunks.push({
				type: "add",
				filePath,
				content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
			});
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			hunks.push({ type: "delete", filePath: line.slice("*** Delete File: ".length) });
			index++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const filePath = line.slice("*** Update File: ".length);
			index++;
			let movePath: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				movePath = (lines[index] ?? "").slice("*** Move to: ".length);
				index++;
			}

			const chunks: PatchChunk[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.trim() === "") {
					index++;
					continue;
				}
				if (nextLine.startsWith("*** ")) {
					break;
				}

				const allowMissingContext = chunks.length === 0;
				const changeContexts: string[] = [];
				if (nextLine.startsWith("@@")) {
					while (index < endIndex) {
						const contextLine = lines[index] ?? "";
						if (contextLine === "@@") {
							index++;
							continue;
						}
						if (contextLine.startsWith("@@ ")) {
							changeContexts.push(contextLine.slice("@@ ".length));
							index++;
							continue;
						}
						break;
					}
				} else if (!allowMissingContext) {
					throw new Error(`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`);
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				let isEndOfFile = false;
				let parsedLines = 0;
				while (index < endIndex) {
					const hunkLine = lines[index] ?? "";
					if (hunkLine === "*** End of File") {
						if (parsedLines === 0) {
							throw new Error("Update hunk does not contain any lines");
						}
						isEndOfFile = true;
						index++;
						break;
					}
					if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) {
						break;
					}
					const prefix = hunkLine[0];
					const value = hunkLine.slice(1);
					if (prefix === undefined) {
						oldLines.push("");
						newLines.push("");
					} else if (prefix === " ") {
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === "-") {
						oldLines.push(value);
					} else if (prefix === "+") {
						newLines.push(value);
					} else if (parsedLines > 0) {
						break;
					} else {
						throw new Error(
							`Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						);
					}
					parsedLines++;
					index++;
				}

				if (parsedLines === 0) {
					throw new Error("Update hunk does not contain any lines");
				}
				chunks.push({ changeContexts, oldLines, newLines, isEndOfFile });
			}
			if (chunks.length === 0 && !movePath) {
				throw new Error(`Update file hunk for path '${filePath}' is empty`);
			}

			hunks.push({ type: "update", filePath, movePath, chunks });
			continue;
		}

		throw new Error(
			`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		);
	}

	return hunks;
}

function splitFileLines(content: string): string[] {
	const lines = normalizePatchText(content).split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function replaceChunks(content: string, filePath: string, chunks: PatchChunk[]): string {
	const originalLines = splitFileLines(content);
	const replacements: { start: number; oldLength: number; newLines: string[] }[] = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		for (const changeContext of chunk.changeContexts) {
			const contextIndex = seekSequence(originalLines, [changeContext], lineIndex, false);
			if (contextIndex === undefined) {
				throw new Error(`Failed to find context '${changeContext}' in ${filePath}`);
			}
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push({ start: insertionIndex, oldLength: 0, newLines: chunk.newLines });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (foundAt === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newLines[newLines.length - 1] === "") {
				newLines = newLines.slice(0, -1);
			}
			foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (foundAt === undefined) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}

		replacements.push({ start: foundAt, oldLength: pattern.length, newLines });
		lineIndex = foundAt + pattern.length;
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
	}
	nextLines.push("");
	return nextLines.join("\n");
}

async function applyParsedPatch(cwd: string, hunks: ParsedPatch[]): Promise<string[]> {
	const summaries: string[] = [];

	for (const hunk of hunks) {
		const absolutePath = await resolveWorkspacePath(cwd, hunk.filePath);
		if (hunk.type === "add") {
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await assertWorkspacePath(cwd, absolutePath);
			await writeFile(absolutePath, hunk.content, "utf-8");
			summaries.push(`add: ${hunk.filePath}`);
			continue;
		}

		if (hunk.type === "delete") {
			await stat(absolutePath);
			await assertWorkspacePath(cwd, absolutePath);
			await rm(absolutePath);
			summaries.push(`delete: ${hunk.filePath}`);
			continue;
		}

		const currentContent = await readFile(absolutePath, "utf-8");
		const nextContent =
			hunk.chunks.length === 0 ? currentContent : replaceChunks(currentContent, hunk.filePath, hunk.chunks);

		if (hunk.movePath) {
			const absoluteMovePath = await resolveWorkspacePath(cwd, hunk.movePath);
			await mkdir(path.dirname(absoluteMovePath), { recursive: true });
			await assertWorkspacePath(cwd, absoluteMovePath);
			await writeFile(absoluteMovePath, nextContent, "utf-8");
			if (absoluteMovePath !== absolutePath) {
				await rm(absolutePath);
			}
			summaries.push(`move: ${hunk.filePath} -> ${hunk.movePath}`);
			continue;
		}

		await assertWorkspacePath(cwd, absolutePath);
		await writeFile(absolutePath, nextContent, "utf-8");
		summaries.push(`update: ${hunk.filePath}`);
	}

	return summaries;
}

export async function applyPatch(cwd: string, patchText: string): Promise<string[]> {
	const hunks = parsePatch(patchText);
	if (hunks.length === 0) {
		const normalized = normalizePatchText(patchText).trim();
		if (normalized === "*** Begin Patch\n*** End Patch") {
			throw new Error("patch rejected: empty patch");
		}
		throw new Error("apply_patch verification failed: no hunks found");
	}

	return applyParsedPatch(cwd, hunks);
}

async function createPendingPatchUpdate(cwd: string, patchText: string): Promise<string> {
	try {
		const hunks = parsePatch(patchText);
		if (hunks.length === 0) {
			return "Applying patch...";
		}

		const diff = await createPatchPreview(cwd, hunks);
		if (diff.trim().length > 0) {
			return `Applying patch...\n${diff}`;
		}
	} catch {
		return formatPendingPatchPaths(patchText);
	}

	return formatPendingPatchPaths(patchText);
}

function hasEditTools(toolNames: string[]): boolean {
	return toolNames.some((toolName) => EDIT_TOOL_NAMES.has(toolName));
}

function withoutApplyPatch(toolNames: string[]): string[] {
	return toolNames.filter((toolName) => toolName !== "apply_patch");
}

function replaceEditToolsWithApplyPatch(toolNames: string[]): string[] {
	const filteredToolNames = withoutApplyPatch(toolNames).filter((toolName) => !EDIT_TOOL_NAMES.has(toolName));
	if (!hasEditTools(toolNames)) {
		return filteredToolNames;
	}
	return [...filteredToolNames, "apply_patch"];
}

function restoreEditToolsFromBaseline(currentToolNames: string[], baselineToolNames: string[]): string[] {
	const restoredToolNames = [
		...withoutApplyPatch(currentToolNames),
		...baselineToolNames.filter((toolName) => EDIT_TOOL_NAMES.has(toolName)),
	];
	return [...new Set(restoredToolNames)];
}

function isInsideWorkspace(absoluteCwd: string, absolutePath: string): boolean {
	const relativePath = path.relative(absoluteCwd, absolutePath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	);
}

async function assertWorkspacePath(cwd: string, absolutePath: string): Promise<void> {
	const absoluteCwd = await realpath(cwd);
	let pathToCheck = absolutePath;
	while (true) {
		try {
			const realPath = await realpath(pathToCheck);
			if (!isInsideWorkspace(absoluteCwd, realPath)) {
				throw new Error("File references must stay within the current workspace.");
			}
			return;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				const parent = path.dirname(pathToCheck);
				if (parent === pathToCheck) {
					throw error;
				}
				pathToCheck = parent;
				continue;
			}
			throw error;
		}
	}
}

async function resolveWorkspacePath(cwd: string, filePath: string): Promise<string> {
	const absoluteCwd = path.resolve(cwd);
	const absolutePath = path.resolve(absoluteCwd, filePath);
	if (!isInsideWorkspace(absoluteCwd, absolutePath)) {
		throw new Error("File references must stay within the current workspace.");
	}
	await assertWorkspacePath(cwd, absolutePath);

	return absolutePath;
}

function syncToolset(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	model: Model<string> | undefined,
	state: BaselineState,
): void {
	const currentToolNames = pi.getActiveTools();
	if (isOpenAIGptModel(model)) {
		if (hasEditTools(currentToolNames)) {
			state.nonGptToolNames = withoutApplyPatch(currentToolNames);
		}
		pi.setActiveTools(replaceEditToolsWithApplyPatch(currentToolNames));
		return;
	}

	if (state.nonGptToolNames.length > 0) {
		const restoredToolNames = restoreEditToolsFromBaseline(currentToolNames, state.nonGptToolNames);
		state.nonGptToolNames = restoredToolNames;
		pi.setActiveTools(restoredToolNames);
		return;
	}

	state.nonGptToolNames = withoutApplyPatch(currentToolNames);
	pi.setActiveTools(state.nonGptToolNames);
}

// Codex-style guidance lifted from `codex-rs/core/gpt_5_2_prompt.md` (Task
// execution + apply_patch sections). These surface inside the dynamic system
// prompt's `## Available Tools` and `## Tool Guidelines` sections so the model
// sees apply_patch in the prompt body, not just in the function-calling schema.
export const APPLY_PATCH_PROMPT_SNIPPET =
	"Patch files in the working tree using the Codex apply_patch envelope (FREEFORM, not JSON).";
export const APPLY_PATCH_PROMPT_GUIDELINES: readonly string[] = [
	"Use `apply_patch` for ALL file edits and creations. Do NOT write or modify files via bash heredoc (`cat >`, `echo > `), `sed -i`, `awk -i`, or inline `python`/`python3 -c` scripts.",
	"Do not re-read a file immediately after a successful `apply_patch`. The call returns success/failure directly.",
];

export function createApplyPatchTool(): ApplyPatchToolDefinition {
	const tool = defineTool({
		name: "apply_patch",
		label: "ApplyPatch",
		description: APPLY_PATCH_FREEFORM_DESCRIPTION,
		promptSnippet: APPLY_PATCH_PROMPT_SNIPPET,
		promptGuidelines: [...APPLY_PATCH_PROMPT_GUIDELINES],
		parameters: APPLY_PATCH_PARAMS,
		prepareArguments: normalizeApplyPatchArguments,
		async execute(_toolCallId, params, _signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const normalizedParams = normalizeApplyPatchArguments(params);
			if (!normalizedParams.input) {
				throw new Error("input is required");
			}

			onUpdate?.({
				content: [{ type: "text", text: await createPendingPatchUpdate(ctx.cwd, normalizedParams.input) }],
				details: undefined,
			});

			const summaries = await applyPatch(ctx.cwd, normalizedParams.input);
			return {
				content: [{ type: "text", text: summaries.join("\n") }],
				details: {},
			};
		},
	});

	return Object.assign(tool, {
		freeform: {
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		} satisfies FreeformToolFormat,
	});
}

export function registerApplyPatchExtension(pi: ApplyPatchExtensionAPI): void {
	const state: BaselineState = {
		nonGptToolNames: [],
	};

	pi.registerTool(createApplyPatchTool());

	pi.on("session_start", async (_event, ctx) => {
		syncToolset(pi, ctx.model, state);
	});

	pi.on("model_select", async (event) => {
		syncToolset(pi, event.model, state);
	});
}

export default registerApplyPatchExtension;
