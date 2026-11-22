import {
	createDefaultReadSummary,
	prepareReadFolder,
	type ReadFolder,
} from "@earendil-works/pi-agent-core/read-folders";
import type { TextContent } from "@earendil-works/pi-ai";
import { utf8ByteLength } from "./encoding.ts";
import { modelOnlyText } from "./model-only-text.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * What the model sees for a text file: the selected lines, folded or truncated, with a continuation notice for the
 * model alone. Undefined when the read was aborted meanwhile.
 */
export async function shapeTextRead(input: {
	path: string;
	absolutePath: string;
	textContent: string;
	offset: number | undefined;
	limit: number | undefined;
	folder: ReadFolder | undefined;
	isAborted: () => boolean;
}): Promise<{ content: TextContent[]; details: ReadToolDetails | undefined } | undefined> {
	const { path, absolutePath, textContent, offset, limit, folder, isAborted } = input;
	let details: ReadToolDetails | undefined;
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	// Check if offset is out of bounds.
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}
	// Apply truncation, respecting both line and byte limits.
	const truncation = truncateHead(selectedContent);
	// A selected grammar loads lazily here, on the first structural read for its language.
	const prepared = await prepareReadFolder(absolutePath, folder);
	if (isAborted()) return undefined;
	const summary = createDefaultReadSummary({
		path: absolutePath,
		text: textContent,
		offset,
		limit,
		folder: prepared,
		truncated: truncation.truncated,
	});
	let outputText: string;
	let notice: string | undefined;
	if (summary) {
		outputText = summary.text;
	} else if (truncation.firstLineExceedsLimit) {
		// First line alone exceeds the byte limit. Point the model at a bash fallback.
		const firstLineSize = formatSize(utf8ByteLength(allLines[startLine] ?? ""));
		outputText = "";
		notice = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation };
	} else if (truncation.truncated) {
		// Truncation occurred. Build an actionable continuation notice.
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === "lines") {
			notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		// User-specified limit stopped early, but the file still has more content.
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = truncation.content;
		notice = `[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		// No truncation and no remaining user-limited content.
		outputText = truncation.content;
	}
	// Text adapters join parts with a newline; retain the original blank line.
	const content: TextContent[] =
		outputText || notice === undefined
			? [{ type: "text", text: notice === undefined ? outputText : `${outputText}\n` }]
			: [];
	if (notice !== undefined) content.push(modelOnlyText(notice));
	return { content, details };
}
