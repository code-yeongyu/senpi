import path from "node:path";
import { parsePatch } from "./parser.js";
import { extractPatchedPaths } from "./text.js";
import type {
	ApplyPatchOperation,
	ApplyPatchPreview,
	ApplyPatchPreviewFile,
	ApplyPatchRenderState,
	ApplyPatchTheme,
} from "./types.js";

export const PATCH_PREVIEW_MAX_LINES = 16;
export const PATCH_PREVIEW_MAX_CHARS = 4000;
const PATCH_PREVIEW_HEAD_LINES = 8;
const PATCH_PREVIEW_TAIL_LINES = 8;
const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

function formatLineCountSummary(added: number, removed: number): string {
	return `(+${added} -${removed})`;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}

export function truncatePreview(text: string): string {
	if (text.length <= PATCH_PREVIEW_MAX_CHARS && countLines(text) <= PATCH_PREVIEW_MAX_LINES) return text;
	const lines = text.split("\n");
	const head = lines.slice(0, PATCH_PREVIEW_HEAD_LINES);
	const tail = lines.slice(-PATCH_PREVIEW_TAIL_LINES);
	let preview = [...head, "…", ...tail].join("\n");
	if (preview.length > PATCH_PREVIEW_MAX_CHARS) preview = `${preview.slice(0, PATCH_PREVIEW_MAX_CHARS).trimEnd()}\n…`;
	return preview;
}

export function displayPath(filePath: string, cwd: string): string {
	if (!path.isAbsolute(filePath)) return filePath;
	const absoluteCwd = path.resolve(cwd);
	const relativePath = path.relative(absoluteCwd, filePath);
	if (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	) {
		return relativePath || ".";
	}
	return filePath;
}

function formatPatchFilePath(file: ApplyPatchPreviewFile, cwd: string = process.cwd()): string {
	const filePath = displayPath(file.filePath, cwd);
	if (!file.movePath) return filePath;
	return `${filePath} → ${displayPath(file.movePath, cwd)}`;
}

function formatPatchOperation(operation: ApplyPatchOperation): string {
	if (operation === "add") return "Added";
	if (operation === "delete") return "Deleted";
	return "Edited";
}

export function formatPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string = process.cwd(),
	expanded: boolean = true,
): string {
	const lines: string[] = [];
	if (preview.files.length === 1) {
		const file = preview.files[0];
		if (file) {
			lines.push(
				`• ${formatPatchOperation(file.operation)} ${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`,
			);
			if (expanded && file.diff)
				lines.push(
					...truncatePreview(file.diff)
						.split("\n")
						.map((line) => `  ${line}`),
				);
		}
		return lines.join("\n");
	}

	const noun = preview.files.length === 1 ? "file" : "files";
	lines.push(`• Edited ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}`);
	for (const file of preview.files) {
		lines.push(`  └ ${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`);
		if (expanded && file.diff)
			lines.push(
				...truncatePreview(file.diff)
					.split("\n")
					.map((line) => `    ${line}`),
			);
	}
	return lines.join("\n");
}

export function formatInFlightCallText(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) return "Patching";
	const noun = paths.length === 1 ? "file" : "files";
	const count = paths.length > 1 ? ` (${paths.length} ${noun})` : "";
	return `Patching${count}: ${paths.join(", ")}`;
}

export function getApplyPatchRenderState(toolCallId: string, cwd: string, patchText: string): ApplyPatchRenderState {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (existing && existing.cwd === cwd && existing.patchText === patchText) return existing;

	const callText = formatInFlightCallText(patchText);
	let collapsed = "";
	let expanded = "";
	try {
		const hunks = parsePatch(patchText);
		if (hunks.length > 0) {
			const files = hunks.map((hunk) => ({
				filePath: hunk.filePath,
				movePath: hunk.type === "update" ? hunk.movePath : undefined,
				operation: hunk.type,
				diff: "",
				added: 0,
				removed: 0,
			})) satisfies ApplyPatchPreviewFile[];
			const preview: ApplyPatchPreview = { files, added: 0, removed: 0 };
			collapsed = formatPatchPreview(preview, cwd, false);
			expanded = formatPatchPreview(preview, cwd, true);
		}
	} catch {
		// ignore incomplete patch text
	}

	const nextState: ApplyPatchRenderState = { ...existing, cwd, patchText, callText, collapsed, expanded };
	applyPatchRenderStates.set(toolCallId, nextState);
	return nextState;
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

export function renderPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string,
	theme: ApplyPatchTheme,
	expanded: boolean,
): string {
	return formatPatchPreview(preview, cwd, expanded)
		.split("\n")
		.map((line) => renderPatchLine(line, theme))
		.join("\n");
}

export function formatPendingPatchPaths(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) return "Applying patch...";
	return `Applying patch...\n${paths.map((filePath) => `• ${filePath}`).join("\n")}`;
}

export function renderPatchLine(line: string, theme: ApplyPatchTheme): string {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("+")) return theme.fg("toolDiffAdded", line);
	if (trimmed.startsWith("-")) return theme.fg("toolDiffRemoved", line);
	if (trimmed.startsWith("•")) return theme.fg("toolTitle", theme.bold(line));
	if (trimmed.startsWith("└")) return theme.fg("accent", line);
	return theme.fg("toolDiffContext", line);
}
