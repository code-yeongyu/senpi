import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../types.js";

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
	oldLines: string[];
	newLines: string[];
};

type BaselineState = {
	nonGptToolNames: string[];
};

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
	"Use the `apply_patch` tool to edit files. Your patch language is a stripped\u2011down, file\u2011oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high\u2011level envelope:\n\n" +
	"*** Begin Patch\n" +
	"[ one or more file sections ]\n" +
	"*** End Patch\n\n" +
	"Within that envelope, you get a sequence of file operations.\n" +
	"You MUST include a header to specify the action you are taking.\n" +
	"Each operation starts with one of three headers:\n\n" +
	"*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\n" +
	"*** Delete File: <path> - remove an existing file. Nothing follows.\n" +
	"*** Update File: <path> - patch an existing file in place (optionally with a rename).\n\n" +
	"Example patch:\n\n" +
	"```\n" +
	"*** Begin Patch\n" +
	"*** Add File: hello.txt\n" +
	"+Hello world\n" +
	"*** Update File: src/app.py\n" +
	"*** Move to: src/main.py\n" +
	"@@ def greet():\n" +
	'-print("Hi")\n' +
	'+print("Hello, world!")\n' +
	"*** Delete File: obsolete.txt\n" +
	"*** End Patch\n" +
	"```\n\n" +
	"It is important to remember:\n\n" +
	"- You must include a header with your intended action (Add/Delete/Update)\n" +
	"- You must prefix new lines with `+` even when creating a new file\n";

export function isOpenAIGptModel(model: Pick<Model<string>, "provider" | "id"> | undefined): boolean {
	return model?.provider === "openai" && model.id.startsWith("gpt-");
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

export function extractPatchedPaths(patchText: string): string[] {
	const normalized = stripHeredoc(normalizePatchText(patchText));
	const matches = normalized.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm);
	return Array.from(matches, (match) => match[1] ?? "");
}

function parsePatch(patchText: string): ParsedPatch[] {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim());
	const lines = normalized.split("\n");
	const beginIndex = lines.findIndex((line) => line.trim() === "*** Begin Patch");
	const endIndex = lines.findIndex((line) => line.trim() === "*** End Patch");

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
			hunks.push({ type: "add", filePath, content: contentLines.join("\n") });
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
				if (nextLine.startsWith("*** ")) {
					break;
				}
				if (nextLine === "*** End of File") {
					index++;
					continue;
				}
				if (nextLine.startsWith("@@")) {
					index++;
					const oldLines: string[] = [];
					const newLines: string[] = [];
					while (index < endIndex) {
						const hunkLine = lines[index] ?? "";
						if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) {
							break;
						}
						if (hunkLine === "*** End of File") {
							index++;
							break;
						}
						const prefix = hunkLine[0];
						const value = hunkLine.slice(1);
						if (prefix === " ") {
							oldLines.push(value);
							newLines.push(value);
						} else if (prefix === "-") {
							oldLines.push(value);
						} else if (prefix === "+") {
							newLines.push(value);
						} else {
							throw new Error("Invalid patch format: update lines must start with ' ', '-', or '+'");
						}
						index++;
					}
					chunks.push({ oldLines, newLines });
					continue;
				}
				throw new Error(`Invalid patch format: unexpected line "${nextLine}"`);
			}

			hunks.push({ type: "update", filePath, movePath, chunks });
			continue;
		}

		index++;
	}

	return hunks;
}

function replaceChunk(
	content: string,
	chunk: PatchChunk,
	searchStart: number,
): { content: string; nextSearchStart: number } {
	const oldBlock = chunk.oldLines.join("\n");
	const newBlock = chunk.newLines.join("\n");

	if (oldBlock.length === 0) {
		return {
			content: content.slice(0, searchStart) + newBlock + content.slice(searchStart),
			nextSearchStart: searchStart + newBlock.length,
		};
	}

	const foundAt = content.indexOf(oldBlock, searchStart);
	if (foundAt === -1) {
		throw new Error(`Failed to find patch chunk:\n${oldBlock}`);
	}

	return {
		content: content.slice(0, foundAt) + newBlock + content.slice(foundAt + oldBlock.length),
		nextSearchStart: foundAt + newBlock.length,
	};
}

async function applyParsedPatch(cwd: string, hunks: ParsedPatch[]): Promise<string[]> {
	const summaries: string[] = [];

	for (const hunk of hunks) {
		const absolutePath = resolveWorkspacePath(cwd, hunk.filePath);
		if (hunk.type === "add") {
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, hunk.content, "utf-8");
			summaries.push(`add: ${hunk.filePath}`);
			continue;
		}

		if (hunk.type === "delete") {
			await stat(absolutePath);
			await rm(absolutePath);
			summaries.push(`delete: ${hunk.filePath}`);
			continue;
		}

		let nextContent = normalizePatchText(await readFile(absolutePath, "utf-8"));
		let searchStart = 0;
		for (const chunk of hunk.chunks) {
			const result = replaceChunk(nextContent, chunk, searchStart);
			nextContent = result.content;
			searchStart = result.nextSearchStart;
		}

		if (hunk.movePath) {
			const absoluteMovePath = resolveWorkspacePath(cwd, hunk.movePath);
			await mkdir(path.dirname(absoluteMovePath), { recursive: true });
			await writeFile(absoluteMovePath, nextContent, "utf-8");
			if (absoluteMovePath !== absolutePath) {
				await rm(absolutePath);
			}
			summaries.push(`move: ${hunk.filePath} -> ${hunk.movePath}`);
			continue;
		}

		await writeFile(absolutePath, nextContent, "utf-8");
		summaries.push(`update: ${hunk.filePath}`);
	}

	return summaries;
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

function resolveWorkspacePath(cwd: string, filePath: string): string {
	if (path.isAbsolute(filePath)) {
		throw new Error("File references can only be relative, NEVER ABSOLUTE.");
	}

	const absolutePath = path.resolve(cwd, filePath);
	const relativePath = path.relative(cwd, absolutePath);
	if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
		throw new Error("File references must stay within the current workspace.");
	}

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

export function createApplyPatchTool(): ToolDefinition<typeof APPLY_PATCH_PARAMS> {
	return defineTool({
		name: "apply_patch",
		label: "ApplyPatch",
		description: APPLY_PATCH_FREEFORM_DESCRIPTION,
		parameters: APPLY_PATCH_PARAMS,
		freeform: {
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			if (!params.input) {
				throw new Error("input is required");
			}

			const hunks = parsePatch(params.input);
			if (hunks.length === 0) {
				const normalized = normalizePatchText(params.input).trim();
				if (normalized === "*** Begin Patch\n*** End Patch") {
					throw new Error("patch rejected: empty patch");
				}
				throw new Error("apply_patch verification failed: no hunks found");
			}

			const summaries = await applyParsedPatch(ctx.cwd, hunks);
			return {
				content: [{ type: "text", text: summaries.join("\n") }],
				details: {},
			};
		},
	});
}

export default function gptApplyPatchExtension(pi: ExtensionAPI): void {
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
