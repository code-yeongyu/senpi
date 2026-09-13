import { __testWriteFileAtomic, applySingleHunk, patchMutationPaths } from "./apply-operation.ts";
import { ApplyPatchError } from "./errors.ts";
import { parsePatch } from "./parser.ts";
import { createRecoveryInstructions } from "./recovery.ts";

export { buildPartialFailureText } from "./recovery.ts";
export { __testWriteFileAtomic };

import { normalizePatchText } from "./text.ts";
import { type PatchTransaction, runPatchTransaction } from "./transaction.ts";
import type {
	AppliedPatchOperation,
	ApplyPatchFailure,
	ApplyPatchProgressCallback,
	ApplyPatchResult,
	ParsedPatch,
} from "./types.ts";

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

function parseNonEmptyPatch(patchText: string): ParsedPatch[] {
	const hunks = parsePatch(patchText);
	if (hunks.length === 0) {
		const normalized = normalizePatchText(patchText).trim();
		if (normalized === "*** Begin Patch\n*** End Patch") throw new Error("patch rejected: empty patch");
		throw new Error("apply_patch verification failed: no hunks found");
	}
	return hunks;
}

type DetailedResultInput = {
	readonly summaries: string[];
	readonly appliedFiles: string[];
	readonly failures: ApplyPatchFailure[];
	readonly fuzz: number;
	readonly appliedOperations: AppliedPatchOperation[];
};

function createDetailedResult(input: DetailedResultInput): ApplyPatchResult {
	const result: ApplyPatchResult = {
		summaries: input.summaries,
		appliedFiles: input.appliedFiles,
		failures: input.failures,
		hasPartialSuccess: input.appliedFiles.length > 0 && input.failures.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: [] },
		details: { fuzz: input.fuzz, appliedOperations: input.appliedOperations },
	};
	result.recoveryInstructions = createRecoveryInstructions(result);
	return result;
}

function createCancellationResult(hunk: ParsedPatch, operationIndex: number, error: unknown): ApplyPatchResult {
	const failures: ApplyPatchFailure[] = [
		{
			operationIndex,
			filePath: hunk.filePath,
			operation: hunk.type,
			message: error instanceof Error ? error.message : String(error),
			code: extractErrorCode(error),
		},
	];
	return createDetailedResult({ summaries: [], appliedFiles: [], failures, fuzz: 0, appliedOperations: [] });
}

type ApplyPatchDetailedHunksInput = {
	readonly cwd: string;
	readonly hunks: readonly ParsedPatch[];
	readonly onProgress?: ApplyPatchProgressCallback;
	readonly transaction?: PatchTransaction;
};

async function applyPatchDetailedHunks(input: ApplyPatchDetailedHunksInput): Promise<ApplyPatchResult> {
	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const appliedOperations: AppliedPatchOperation[] = [];
	const failures: ApplyPatchFailure[] = [];
	let fuzz = 0;

	for (const [operationIndex, hunk] of input.hunks.entries()) {
		if (input.transaction) input.transaction.operationIndex = operationIndex;
		input.transaction?.checkCancelled();
		try {
			const applied = await applySingleHunk(input.cwd, hunk, input.transaction !== undefined);
			summaries.push(applied.summary);
			appliedFiles.push(applied.appliedFile);
			appliedOperations.push({ operationIndex, preview: applied.preview });
			fuzz += applied.fuzz;
		} catch (error) {
			if (input.transaction) input.transaction.checkCancelled();
			const message = error instanceof Error ? error.message : String(error);
			const code = extractErrorCode(error);
			failures.push({ operationIndex, filePath: hunk.filePath, operation: hunk.type, message, code });
		}
		await notifyApplyPatchProgress(input.onProgress, {
			applied: appliedFiles.length,
			failed: failures.length,
			total: input.hunks.length,
		});
		input.transaction?.checkCancelled();
	}

	return createDetailedResult({ summaries, appliedFiles, failures, fuzz, appliedOperations });
}

export async function applyPatchDetailed(
	cwd: string,
	patchText: string,
	onProgress?: ApplyPatchProgressCallback,
	signal?: AbortSignal,
): Promise<ApplyPatchResult> {
	const hunks = parseNonEmptyPatch(patchText);
	if (!signal) return applyPatchDetailedHunks({ cwd, hunks, onProgress });
	if (signal.aborted) {
		const error = new Error("Operation aborted") as NodeJS.ErrnoException;
		error.code = "ABORT_ERR";
		const firstHunk = hunks[0];
		if (!firstHunk) throw error;
		return createCancellationResult(firstHunk, 0, error);
	}

	return runPatchTransaction({
		filePaths: hunks.flatMap((hunk) => patchMutationPaths(cwd, hunk)),
		signal,
		run: (transaction) => applyPatchDetailedHunks({ cwd, hunks, onProgress, transaction }),
		onAbort: (error, transaction) => {
			const failedHunk = hunks[transaction.operationIndex];
			if (!failedHunk) throw error;
			return createCancellationResult(failedHunk, transaction.operationIndex, error);
		},
	});
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
