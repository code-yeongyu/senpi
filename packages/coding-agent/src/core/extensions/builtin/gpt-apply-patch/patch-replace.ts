import { type LineReplacement, replacementsAroundContext, SourceText } from "./line-endings.ts";
import { seekSequenceWithFuzz } from "./seek-sequence.ts";
import type { PatchChunk } from "./types.ts";

export function replaceChunks(
	content: string,
	filePath: string,
	chunks: PatchChunk[],
): { content: string; fuzz: number } {
	const source = SourceText.parse(content);
	const originalLines = source.texts;
	const replacements: LineReplacement[] = [];
	let lineIndex = 0;
	let fuzz = 0;

	for (const chunk of chunks) {
		for (const changeContext of chunk.changeContexts) {
			const contextIndex = seekSequenceWithFuzz(originalLines, [changeContext], lineIndex, false);
			if (contextIndex === undefined) throw new Error(`Failed to find context '${changeContext}' in ${filePath}`);
			fuzz += contextIndex.fuzz;
			lineIndex = contextIndex.index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push({ start: insertionIndex, oldLength: 0, newLines: chunk.newLines });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let foundAt = seekSequenceWithFuzz(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (foundAt === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newLines[newLines.length - 1] === "") newLines = newLines.slice(0, -1);
			foundAt = seekSequenceWithFuzz(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (foundAt === undefined)
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		fuzz += foundAt.fuzz;
		replacements.push(
			...replacementsAroundContext(foundAt.index, pattern.length, newLines, chunk.contextLineIndices),
		);
		lineIndex = foundAt.index + pattern.length;
	}

	return { content: source.replace(replacements), fuzz };
}
