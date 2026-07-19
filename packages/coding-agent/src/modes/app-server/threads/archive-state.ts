import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { enqueueThreadMutation, writeSidecarFileAtomic } from "./metadata-state.ts";
import type { WireThread } from "./registry.ts";

const ARCHIVE_SUFFIX = ".archived";

type ArchivedThreadRecord = {
	readonly archivedAt: string;
	readonly thread: WireThread;
};

class ThreadArchiveStateError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${message}: ${path}`);
		this.name = "ThreadArchiveStateError";
		this.path = path;
	}
}

export class ThreadArchiveState {
	private readonly sessionDir: string | undefined;

	constructor(sessionDir: string | undefined) {
		this.sessionDir = sessionDir;
	}

	async markArchived(thread: WireThread): Promise<void> {
		await enqueueThreadMutation(thread.id, async () => {
			const sidecarPath = sidecarPathForThread(thread);
			await writeSidecarFileAtomic(
				sidecarPath,
				`${JSON.stringify({ archivedAt: new Date().toISOString(), thread } satisfies ArchivedThreadRecord)}\n`,
			);
		});
	}

	async clearArchived(threadId: string): Promise<void> {
		await enqueueThreadMutation(threadId, async () => {
			const threads = await this.listArchivedThreads();
			await Promise.all(
				threads
					.filter((thread) => thread.id === threadId)
					.map((thread) => rm(sidecarPathForThread(thread), { force: true })),
			);
		});
	}

	async isArchived(thread: WireThread): Promise<boolean> {
		const path = sidecarPathForThread(thread);
		try {
			await readFile(path, "utf8");
			return true;
		} catch (error) {
			if (isNotFoundError(error)) {
				return false;
			}
			throw readError(path, error);
		}
	}

	async listArchivedThreads(): Promise<WireThread[]> {
		if (!this.sessionDir) {
			return [];
		}
		let entries: string[];
		try {
			entries = await readdir(this.sessionDir);
		} catch (error) {
			if (isNotFoundError(error)) {
				return [];
			}
			throw readError(this.sessionDir, error);
		}
		const threads: WireThread[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(ARCHIVE_SUFFIX)) {
				continue;
			}
			const thread = await readArchivedThread(join(this.sessionDir, entry));
			if (thread) {
				threads.push(thread);
			}
		}
		return threads;
	}
}

function sidecarPathForThread(thread: WireThread): string {
	if (!thread.sessionPath) {
		throw new Error(`Thread ${thread.id} has no session path for archive state`);
	}
	return `${thread.sessionPath}${ARCHIVE_SUFFIX}`;
}

async function readArchivedThread(path: string): Promise<WireThread | null> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isNotFoundError(error)) {
			return null;
		}
		throw readError(path, error);
	}
	return parseArchivedThread(path, content);
}

function parseArchivedThread(path: string, content: string): WireThread {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		if (error instanceof Error) {
			throw new ThreadArchiveStateError(path, `Invalid archived thread sidecar JSON (${error.message})`);
		}
		throw error;
	}
	if (!isRecord(value) || !isRecord(value.thread)) {
		throw new ThreadArchiveStateError(path, "Invalid archived thread sidecar record");
	}
	const thread = parseWireThread(value.thread);
	if (!thread) {
		throw new ThreadArchiveStateError(path, "Invalid archived thread record");
	}
	return thread;
}

function parseWireThread(value: Record<string, unknown>): WireThread | null {
	const id = stringField(value.id);
	const sessionId = stringField(value.sessionId);
	const cwd = stringField(value.cwd);
	const createdAt = stringField(value.createdAt);
	const updatedAt = stringField(value.updatedAt);
	const status = isRecord(value.status) ? stringField(value.status.type) : null;
	const sessionPath = stringField(value.sessionPath);
	if (!id || !sessionId || !cwd || !createdAt || !updatedAt || !status || !sessionPath) {
		return null;
	}
	if (status !== "idle" && status !== "active" && status !== "notLoaded") {
		return null;
	}
	return {
		id,
		sessionId,
		cwd,
		createdAt,
		updatedAt,
		status: { type: status },
		preview: nullableString(value.preview),
		name: nullableString(value.name),
		sessionPath,
	};
}

function stringField(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
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

function readError(path: string, error: unknown): ThreadArchiveStateError {
	if (error instanceof Error) {
		return new ThreadArchiveStateError(path, `Failed to read archived thread state (${error.message})`);
	}
	return new ThreadArchiveStateError(path, `Failed to read archived thread state (${String(error)})`);
}
