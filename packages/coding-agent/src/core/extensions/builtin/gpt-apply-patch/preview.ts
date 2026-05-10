import { readFile } from "node:fs/promises";
import { parsePatch } from "./parser.js";
import { createPatchDiff } from "./patch-diff.js";
import { replaceChunks } from "./patch-replace.js";
import { formatPatchPreview, formatPendingPatchPaths } from "./preview-format.js";
import type { ApplyPatchPreview, ApplyPatchPreviewFile, ApplyPatchToolDetails, ParsedPatch } from "./types.js";
import { resolveWorkspacePath } from "./workspace.js";

async function readExistingFileForPreview(absolutePath: string): Promise<string> {
	try {
		return await readFile(absolutePath, "utf-8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

export async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<ApplyPatchPreview> {
	const files: ApplyPatchPreviewFile[] = [];
	for (const hunk of hunks) {
		const absolutePath = await resolveWorkspacePath(cwd, hunk.filePath);
		if (hunk.type === "add") {
			const oldContent = await readExistingFileForPreview(absolutePath);
			const diff = createPatchDiff(oldContent, hunk.content);
			files.push({ filePath: hunk.filePath, operation: oldContent.length > 0 ? "update" : "add", ...diff });
			continue;
		}

		if (hunk.type === "delete") {
			const oldContent = await readFile(absolutePath, "utf-8");
			const diff = createPatchDiff(oldContent, "");
			files.push({ filePath: hunk.filePath, operation: "delete", ...diff });
			continue;
		}

		const oldContent = await readFile(absolutePath, "utf-8");
		const newContent =
			hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks).content;
		if (hunk.movePath) await resolveWorkspacePath(cwd, hunk.movePath);
		const diff = createPatchDiff(oldContent, newContent);
		files.push({ filePath: hunk.filePath, movePath: hunk.movePath, operation: "update", ...diff });
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
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	try {
		const hunks = parsePatch(patchText);
		if (hunks.length === 0) return { text: "Applying patch...", details: undefined };
		const preview = await createPatchPreview(cwd, hunks);
		if (preview.files.some((file) => file.diff.trim().length > 0)) {
			return { text: `Applying patch...\n${formatPatchPreview(preview)}`, details: { preview } };
		}
	} catch {
		return { text: formatPendingPatchPaths(patchText), details: undefined };
	}
	return { text: formatPendingPatchPaths(patchText), details: undefined };
}
