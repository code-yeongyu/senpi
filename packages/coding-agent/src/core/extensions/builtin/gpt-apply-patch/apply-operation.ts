import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueues } from "../../../tools/file-mutation-queue.ts";
import { replaceChunks } from "./patch-replace.ts";
import { buildPatchPreviewFile, readPatchFileSnapshot } from "./preview.ts";
import type { AtomicWriteOperations, ParsedPatch } from "./types.ts";
import { resolvePatchPath } from "./workspace.ts";

const ATOMIC_WRITE_OPERATIONS: AtomicWriteOperations = { writeFile, rename, unlink };

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
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

async function writeBinaryFileAtomic(absPath: string, content: Uint8Array): Promise<void> {
	const tempPath = `${absPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	await writeFile(tempPath, content);
	try {
		await rename(tempPath, absPath);
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
		await unlink(absPath);
		await rename(tempPath, absPath);
	}
}

export async function __testWriteFileAtomic(
	absPath: string,
	content: string,
	operations: AtomicWriteOperations,
): Promise<void> {
	await writeFileAtomic(absPath, content, operations);
}

export function patchMutationPaths(cwd: string, hunk: ParsedPatch): string[] {
	return hunk.type === "update" && hunk.movePath
		? [resolvePatchPath(cwd, hunk.filePath), resolvePatchPath(cwd, hunk.movePath)]
		: [resolvePatchPath(cwd, hunk.filePath)];
}

async function applySingleHunkUnlocked(
	cwd: string,
	hunk: ParsedPatch,
): Promise<{
	readonly summary: string;
	readonly appliedFile: string;
	readonly fuzz: number;
	readonly preview: ReturnType<typeof buildPatchPreviewFile>;
}> {
	const absolutePath = resolvePatchPath(cwd, hunk.filePath);
	if (hunk.type === "add") {
		const source = await readPatchFileSnapshot(absolutePath);
		const preview = buildPatchPreviewFile({ hunk, source, newContent: hunk.content });
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFileAtomic(absolutePath, hunk.content);
		return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0, preview };
	}

	if (hunk.type === "delete") {
		const source = await readPatchFileSnapshot(absolutePath);
		const preview = buildPatchPreviewFile({ hunk, source, newContent: "" });
		await rm(absolutePath);
		return { summary: `delete: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0, preview };
	}

	const source = await readPatchFileSnapshot(absolutePath);
	if (!source.exists) {
		const error = new Error(`ENOENT: no such file or directory, open '${absolutePath}'`) as NodeJS.ErrnoException;
		error.code = "ENOENT";
		throw error;
	}
	const absoluteMovePath = hunk.movePath ? resolvePatchPath(cwd, hunk.movePath) : undefined;
	const moveDestination =
		absoluteMovePath && absoluteMovePath !== absolutePath ? await readPatchFileSnapshot(absoluteMovePath) : undefined;
	if (source.binary) {
		if (hunk.chunks.length > 0) {
			throw new Error(`apply_patch cannot apply text hunks to binary file: ${hunk.filePath}`);
		}
		if (!hunk.movePath || !absoluteMovePath || !source.bytes) {
			throw new Error(`apply_patch cannot update binary file without a move destination: ${hunk.filePath}`);
		}
		const preview = buildPatchPreviewFile({
			hunk,
			source,
			newContent: "",
			...(moveDestination ? { moveDestination } : {}),
		});
		await mkdir(path.dirname(absoluteMovePath), { recursive: true });
		await writeBinaryFileAtomic(absoluteMovePath, source.bytes);
		if (absoluteMovePath !== absolutePath) await rm(absolutePath);
		return {
			summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
			appliedFile: hunk.movePath,
			fuzz: 0,
			preview,
		};
	}

	const chunkResult =
		hunk.chunks.length === 0
			? { content: source.content, fuzz: 0 }
			: replaceChunks(source.content, hunk.filePath, hunk.chunks);

	if (hunk.movePath && absoluteMovePath) {
		const preview = buildPatchPreviewFile({
			hunk,
			source,
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

	const preview = buildPatchPreviewFile({ hunk, source, newContent: chunkResult.content });
	await writeFileAtomic(absolutePath, chunkResult.content);
	return { summary: `update: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: chunkResult.fuzz, preview };
}

export async function applySingleHunk(cwd: string, hunk: ParsedPatch, queuesHeld = false) {
	if (queuesHeld) return applySingleHunkUnlocked(cwd, hunk);
	return withFileMutationQueues(patchMutationPaths(cwd, hunk), () => applySingleHunkUnlocked(cwd, hunk));
}
