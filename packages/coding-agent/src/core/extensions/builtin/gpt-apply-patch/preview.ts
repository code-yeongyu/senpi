import { readFile } from "node:fs/promises";
import { createUnifiedPatch } from "../../../tools/unified-diff.ts";
import { parsePatch } from "./parser.ts";
import { createPatchDiff } from "./patch-diff.ts";
import { replaceChunks } from "./patch-replace.ts";
import { formatPatchPreview, formatPendingPatchPaths } from "./preview-format.ts";
import type {
	ApplyPatchPreview,
	ApplyPatchPreviewFile,
	ApplyPatchProgress,
	ApplyPatchToolDetails,
	ParsedPatch,
} from "./types.ts";
import { resolvePatchPath } from "./workspace.ts";

export type PatchFileSnapshot = {
	readonly exists: boolean;
	readonly content: string;
};

export async function readPatchFileSnapshot(absolutePath: string): Promise<PatchFileSnapshot> {
	try {
		return { exists: true, content: await readFile(absolutePath, "utf-8") };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { exists: false, content: "" };
		}
		throw error;
	}
}

type MovePatchInput = {
	readonly hunk: Extract<ParsedPatch, { type: "update" }>;
	readonly oldContent: string;
	readonly newContent: string;
	readonly moveDestination: PatchFileSnapshot | undefined;
};

function createMovePatch(input: MovePatchInput): string {
	const { hunk, oldContent, newContent, moveDestination } = input;
	if (!hunk.movePath || hunk.movePath === hunk.filePath) {
		return createUnifiedPatch(hunk.filePath, hunk.movePath ?? hunk.filePath, oldContent, newContent);
	}
	const sourcePatch = createUnifiedPatch(`a/${hunk.filePath}`, "/dev/null", oldContent, "");
	const destinationPatch = moveDestination?.exists
		? moveDestination.content === newContent
			? ""
			: createUnifiedPatch(`a/${hunk.movePath}`, `b/${hunk.movePath}`, moveDestination.content, newContent)
		: createUnifiedPatch("/dev/null", `b/${hunk.movePath}`, "", newContent);
	return `${sourcePatch}${destinationPatch}`;
}

export function buildPatchPreviewFile(input: {
	readonly hunk: ParsedPatch;
	readonly source: PatchFileSnapshot;
	readonly newContent: string;
	readonly moveDestination?: PatchFileSnapshot;
}): ApplyPatchPreviewFile {
	const { hunk, source, newContent, moveDestination } = input;
	switch (hunk.type) {
		case "add": {
			const operation = source.exists ? "update" : "add";
			return {
				filePath: hunk.filePath,
				operation,
				patch: createUnifiedPatch(
					operation === "add" ? "/dev/null" : hunk.filePath,
					hunk.filePath,
					source.content,
					newContent,
				),
				...createPatchDiff(source.content, newContent),
			};
		}
		case "delete":
			return {
				filePath: hunk.filePath,
				operation: "delete",
				patch: createUnifiedPatch(hunk.filePath, "/dev/null", source.content, ""),
				...createPatchDiff(source.content, ""),
			};
		case "update":
			return {
				filePath: hunk.filePath,
				movePath: hunk.movePath,
				operation: "update",
				patch: createMovePatch({ hunk, oldContent: source.content, newContent, moveDestination }),
				...createPatchDiff(source.content, newContent),
			};
		default: {
			const exhaustive: never = hunk;
			return exhaustive;
		}
	}
}

async function createPatchPreviewFile(cwd: string, hunk: ParsedPatch): Promise<ApplyPatchPreviewFile> {
	const absolutePath = resolvePatchPath(cwd, hunk.filePath);
	switch (hunk.type) {
		case "add": {
			const source = await readPatchFileSnapshot(absolutePath);
			return buildPatchPreviewFile({ hunk, source, newContent: hunk.content });
		}
		case "delete": {
			const oldContent = await readFile(absolutePath, "utf-8");
			return buildPatchPreviewFile({
				hunk,
				source: { exists: true, content: oldContent },
				newContent: "",
			});
		}
		case "update": {
			const oldContent = await readFile(absolutePath, "utf-8");
			const newContent =
				hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks).content;
			const moveDestination =
				hunk.movePath && hunk.movePath !== hunk.filePath
					? await readPatchFileSnapshot(resolvePatchPath(cwd, hunk.movePath))
					: undefined;
			return buildPatchPreviewFile({
				hunk,
				source: { exists: true, content: oldContent },
				newContent,
				...(moveDestination ? { moveDestination } : {}),
			});
		}
		default: {
			const exhaustive: never = hunk;
			return exhaustive;
		}
	}
}

function hasPreviewChange(file: ApplyPatchPreviewFile): boolean {
	return file.operation !== "update" || file.movePath !== undefined || file.diff.trim().length > 0;
}

export async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<ApplyPatchPreview> {
	const files: ApplyPatchPreviewFile[] = [];
	for (const hunk of hunks) {
		try {
			files.push(await createPatchPreviewFile(cwd, hunk));
		} catch (error) {
			if (error instanceof Error) continue;
			throw error;
		}
	}

	return {
		files,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}

export async function createPendingPatchUpdate(
	cwd: string,
	patchText: string,
	progress?: ApplyPatchProgress,
	previewOverride?: ApplyPatchPreview,
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	const title = progress
		? `Applying patch (${progress.applied + progress.failed}/${progress.total})...`
		: "Applying patch...";
	if (previewOverride) {
		return {
			text: `${title}\n${formatPatchPreview(previewOverride)}`,
			details: { preview: previewOverride, progress },
		};
	}

	try {
		const hunks = parsePatch(patchText);
		if (hunks.length === 0) return { text: title, details: progress ? { progress } : undefined };
		const preview = await createPatchPreview(cwd, hunks);
		if (preview.files.some(hasPreviewChange)) {
			return { text: `${title}\n${formatPatchPreview(preview)}`, details: { preview, progress } };
		}
	} catch {
		return {
			text: progress ? title : formatPendingPatchPaths(patchText),
			details: progress ? { progress } : undefined,
		};
	}
	return { text: progress ? title : formatPendingPatchPaths(patchText), details: progress ? { progress } : undefined };
}
