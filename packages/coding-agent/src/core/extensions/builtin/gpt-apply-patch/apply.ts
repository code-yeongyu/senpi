import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "../../../tools/file-mutation-queue.ts";
import { ApplyPatchError } from "./errors.ts";
import { parsePatch } from "./parser.ts";
import { replaceChunks } from "./patch-replace.ts";
import { buildPatchPreviewFile, readPatchFileSnapshot } from "./preview.ts";
import { createRecoveryInstructions } from "./recovery.ts";

export { buildPartialFailureText } from "./recovery.ts";

import { normalizePatchText } from "./text.ts";
import type {
	AppliedPatchOperation,
	ApplyPatchFailure,
	ApplyPatchProgressCallback,
	ApplyPatchResult,
	AtomicWriteOperations,
	ParsedPatch,
} from "./types.ts";
import { resolvePatchPath } from "./workspace.ts";

const ATOMIC_WRITE_OPERATIONS: AtomicWriteOperations = { writeFile, rename, unlink };

async function notifyApplyPatchProgress(
	onProgress: ApplyPatchProgressCallback | undefined,
	progress: Parameters<ApplyPatchProgressCallback>[0],
): Promise<void> {
	try {
		await onProgress?.(progress);
	} catch {
		// Rendering progress must not affect patch application or recovery details.
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function extractErrorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

export function compactApplyPatchResult(result: ApplyPatchResult): ApplyPatchResult {
	return {
		...result,
		details: {
			...result.details,
			appliedOperations: result.details.appliedOperations.map(({ operationIndex, preview }) => {
				const { diff: _diff, patch: _patch, ...metadata } = preview;
				return { operationIndex, preview: { ...metadata, diff: "" } };
			}),
		},
	};
}

async function writeFileAtomic(
	absPath: string,
	content: string,
	operations: AtomicWriteOperations = ATOMIC_WRITE_OPERATIONS,
): Promise<void> {
	const tempPath = `${absPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	await operations.writeFile(tempPath, content, "utf-8");
	try {
		await operations.rename(tempPath, absPath);
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
		await operations.unlink(absPath);
		await operations.rename(tempPath, absPath);
	}
}

export async function __testWriteFileAtomic(
	absPath: string,
	content: string,
	operations: AtomicWriteOperations,
): Promise<void> {
	await writeFileAtomic(absPath, content, operations);
}

async function applySingleHunk(
	cwd: string,
	hunk: ParsedPatch,
): Promise<{
	readonly summary: string;
	readonly appliedFile: string;
	readonly fuzz: number;
	readonly preview: ReturnType<typeof buildPatchPreviewFile>;
}> {
	const absolutePath = resolvePatchPath(cwd, hunk.filePath);
	const mutationPaths =
		hunk.type === "update" && hunk.movePath ? [absolutePath, resolvePatchPath(cwd, hunk.movePath)] : [absolutePath];
	return withPatchMutationQueues(mutationPaths, async () => {
		if (hunk.type === "add") {
			const source = await readPatchFileSnapshot(absolutePath);
			const preview = buildPatchPreviewFile({ hunk, source, newContent: hunk.content });
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await writeFileAtomic(absolutePath, hunk.content);
			return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0, preview };
		}

		if (hunk.type === "delete") {
			const oldContent = await readFile(absolutePath, "utf-8");
			const preview = buildPatchPreviewFile({
				hunk,
				source: { exists: true, content: oldContent },
				newContent: "",
			});
			await rm(absolutePath);
			return { summary: `delete: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0, preview };
		}

		const currentContent = await readFile(absolutePath, "utf-8");
		const chunkResult =
			hunk.chunks.length === 0
				? { content: currentContent, fuzz: 0 }
				: replaceChunks(currentContent, hunk.filePath, hunk.chunks);

		if (hunk.movePath) {
			const absoluteMovePath = resolvePatchPath(cwd, hunk.movePath);
			const moveDestination =
				absoluteMovePath === absolutePath ? undefined : await readPatchFileSnapshot(absoluteMovePath);
			const preview = buildPatchPreviewFile({
				hunk,
				source: { exists: true, content: currentContent },
				newContent: chunkResult.content,
				...(moveDestination ? { moveDestination } : {}),
			});
			await mkdir(path.dirname(absoluteMovePath), { recursive: true });
			await writeFileAtomic(absoluteMovePath, chunkResult.content);
			if (absoluteMovePath !== absolutePath) await rm(absolutePath);
			return {
				summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
				appliedFile: hunk.movePath,
				fuzz: chunkResult.fuzz,
				preview,
			};
		}

		const preview = buildPatchPreviewFile({
			hunk,
			source: { exists: true, content: currentContent },
			newContent: chunkResult.content,
		});
		await writeFileAtomic(absolutePath, chunkResult.content);
		return { summary: `update: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: chunkResult.fuzz, preview };
	});
}

async function withPatchMutationQueues<T>(filePaths: readonly string[], operation: () => Promise<T>): Promise<T> {
	const sortedPaths = [...new Set(filePaths)].sort((left, right) => left.localeCompare(right));
	const runQueued = (index: number): Promise<T> => {
		const filePath = sortedPaths[index];
		if (filePath === undefined) return operation();
		return withFileMutationQueue(filePath, () => runQueued(index + 1));
	};
	return runQueued(0);
}

function parseNonEmptyPatch(patchText: string): ParsedPatch[] {
	const hunks = parsePatch(patchText);
	if (hunks.length === 0) {
		const normalized = normalizePatchText(patchText).trim();
		if (normalized === "*** Begin Patch\n*** End Patch") throw new Error("patch rejected: empty patch");
		throw new Error("apply_patch verification failed: no hunks found");
	}
	return hunks;
}

export async function applyPatchDetailed(
	cwd: string,
	patchText: string,
	onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
	const hunks = parseNonEmptyPatch(patchText);
	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const appliedOperations: AppliedPatchOperation[] = [];
	const failures: ApplyPatchFailure[] = [];
	let fuzz = 0;

	for (const [operationIndex, hunk] of hunks.entries()) {
		try {
			const applied = await applySingleHunk(cwd, hunk);
			summaries.push(applied.summary);
			appliedFiles.push(applied.appliedFile);
			appliedOperations.push({ operationIndex, preview: applied.preview });
			fuzz += applied.fuzz;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = extractErrorCode(error);
			failures.push({ operationIndex, filePath: hunk.filePath, operation: hunk.type, message, code });
		}
		await notifyApplyPatchProgress(onProgress, {
			applied: appliedFiles.length,
			failed: failures.length,
			total: hunks.length,
		});
	}

	const result: ApplyPatchResult = {
		summaries,
		appliedFiles,
		failures,
		hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: [] },
		details: { fuzz, appliedOperations },
	};
	result.recoveryInstructions = createRecoveryInstructions(result);
	return result;
}

export async function applyPatch(cwd: string, patchText: string): Promise<string[]> {
	const hunks = parseNonEmptyPatch(patchText);
	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const appliedOperations: AppliedPatchOperation[] = [];
	for (const [operationIndex, hunk] of hunks.entries()) {
		try {
			const applied = await applySingleHunk(cwd, hunk);
			summaries.push(applied.summary);
			appliedFiles.push(applied.appliedFile);
			appliedOperations.push({ operationIndex, preview: applied.preview });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failures: ApplyPatchFailure[] = [
				{ operationIndex, filePath: hunk.filePath, operation: hunk.type, message, code: extractErrorCode(error) },
			];
			const result: ApplyPatchResult = {
				summaries,
				appliedFiles,
				failures,
				hasPartialSuccess: appliedFiles.length > 0,
				recoveryInstructions: createRecoveryInstructions({ appliedFiles, failures }),
				details: { fuzz: 0, appliedOperations },
			};
			throw new ApplyPatchError(message, compactApplyPatchResult(result));
		}
	}

	return summaries;
}
