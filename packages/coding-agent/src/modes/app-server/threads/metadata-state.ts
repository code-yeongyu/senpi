import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GitInfo } from "../protocol/generated/v2/GitInfo.ts";
import type { ThreadMetadataGitInfoUpdateParams } from "../protocol/generated/v2/ThreadMetadataGitInfoUpdateParams.ts";
import type { WireThread } from "./registry.ts";

const METADATA_SUFFIX = ".metadata.json";
const threadMutationQueues = new Map<string, Promise<void>>();

type StoredGitInfo = {
	readonly sha?: string;
	readonly branch?: string;
	readonly originUrl?: string;
};

type ThreadMetadataRecord = {
	readonly gitInfo: StoredGitInfo;
};

export class ThreadMetadataStateError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${message}: ${path}`);
		this.name = "ThreadMetadataStateError";
		this.path = path;
	}
}

export class ThreadMetadataUpdateError extends Error {
	readonly name = "ThreadMetadataUpdateError";
}

/** Serialize mutations to all sidecars belonging to one thread. */
export function enqueueThreadMutation<T>(threadId: string, mutation: () => Promise<T> | T): Promise<T> {
	const previous = threadMutationQueues.get(threadId) ?? Promise.resolve();
	const result = previous.then(mutation, mutation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	threadMutationQueues.set(threadId, settled);
	return result.finally(() => {
		if (threadMutationQueues.get(threadId) === settled) {
			threadMutationQueues.delete(threadId);
		}
	});
}

/** Atomically replace a sidecar using a sibling temporary file and rename. */
export async function writeSidecarFileAtomic(filePath: string, contents: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporaryPath = join(dirname(filePath), `.${basename(filePath)}-${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, filePath);
	} catch (error) {
		try {
			await rm(temporaryPath, { force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"sidecar write failed and its temporary file could not be removed",
			);
		}
		throw error;
	}
}

export function metadataSidecarPathForThread(thread: Pick<WireThread, "id" | "sessionPath">): string {
	if (!thread.sessionPath) {
		throw new Error(`Thread ${thread.id} has no session path for metadata state`);
	}
	return `${thread.sessionPath}${METADATA_SUFFIX}`;
}

export class ThreadMetadataState {
	async readGitInfo(thread: Pick<WireThread, "id" | "sessionPath">): Promise<GitInfo | null> {
		return readGitInfoFromPath(metadataSidecarPathForThread(thread));
	}

	async updateGitInfo(thread: Pick<WireThread, "id" | "sessionPath">, update: unknown): Promise<GitInfo> {
		return enqueueThreadMutation(thread.id, async () => {
			const path = metadataSidecarPathForThread(thread);
			const current = await readGitInfoFromPath(path);
			const next = mergeGitInfo(current, update);
			await writeSidecarFileAtomic(path, `${JSON.stringify(toMetadataRecord(next))}\n`);
			return next;
		});
	}
}

export function parseGitInfoUpdate(value: unknown): ThreadMetadataGitInfoUpdateParams {
	if (!isRecord(value)) {
		throw new ThreadMetadataUpdateError("gitInfo must include at least one field");
	}
	const sha = parseGitInfoUpdateField(value.sha, "sha");
	const branch = parseGitInfoUpdateField(value.branch, "branch");
	const originUrl = parseGitInfoUpdateField(value.originUrl, "originUrl");
	if (sha === undefined && branch === undefined && originUrl === undefined) {
		throw new ThreadMetadataUpdateError("gitInfo must include at least one field");
	}
	return {
		...(sha === undefined ? {} : { sha }),
		...(branch === undefined ? {} : { branch }),
		...(originUrl === undefined ? {} : { originUrl }),
	};
}

export function mergeGitInfo(current: GitInfo | null, update: unknown): GitInfo {
	const parsed = parseGitInfoUpdate(update);
	const baseline = current ?? emptyGitInfo();
	return {
		sha: parsed.sha === undefined ? baseline.sha : parsed.sha,
		branch: parsed.branch === undefined ? baseline.branch : parsed.branch,
		originUrl: parsed.originUrl === undefined ? baseline.originUrl : parsed.originUrl,
	};
}

async function readGitInfoFromPath(path: string): Promise<GitInfo | null> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isNotFoundError(error)) {
			return null;
		}
		throw readError(path, error);
	}

	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new ThreadMetadataStateError(path, `Invalid metadata sidecar JSON (${error.message})`);
		}
		throw error;
	}
	if (!isRecord(value) || !isRecord(value.gitInfo)) {
		throw new ThreadMetadataStateError(path, "Invalid metadata sidecar record");
	}
	return {
		sha: storedGitInfoField(value.gitInfo.sha, path, "sha"),
		branch: storedGitInfoField(value.gitInfo.branch, path, "branch"),
		originUrl: storedGitInfoField(value.gitInfo.originUrl, path, "originUrl"),
	};
}

function parseGitInfoUpdateField(value: unknown, field: string): string | null | undefined {
	if (value === undefined || value === null) return value;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ThreadMetadataUpdateError(`gitInfo.${field} must not be empty`);
	}
	return value.trim();
}

function storedGitInfoField(value: unknown, path: string, field: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ThreadMetadataStateError(path, `Invalid metadata gitInfo.${field}`);
	}
	return value.trim();
}

function toMetadataRecord(gitInfo: GitInfo): ThreadMetadataRecord {
	return {
		gitInfo: {
			...(gitInfo.sha === null ? {} : { sha: gitInfo.sha }),
			...(gitInfo.branch === null ? {} : { branch: gitInfo.branch }),
			...(gitInfo.originUrl === null ? {} : { originUrl: gitInfo.originUrl }),
		},
	};
}

function emptyGitInfo(): GitInfo {
	return { sha: null, branch: null, originUrl: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
	return isNodeFsError(error) && error.code === "ENOENT";
}

function isNodeFsError(error: unknown): error is Error & { readonly code?: string } {
	return error instanceof Error && "code" in error;
}

function readError(path: string, error: unknown): ThreadMetadataStateError {
	if (error instanceof Error) {
		return new ThreadMetadataStateError(path, `Failed to read metadata sidecar (${error.message})`);
	}
	return new ThreadMetadataStateError(path, `Failed to read metadata sidecar (${String(error)})`);
}
