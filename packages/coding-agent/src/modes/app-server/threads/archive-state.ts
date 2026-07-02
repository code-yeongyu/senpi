import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WireThread } from "./registry.ts";

const ARCHIVE_SUFFIX = ".archived";

type ArchivedThreadRecord = {
	readonly archivedAt: string;
	readonly thread: WireThread;
};

export class ThreadArchiveState {
	private readonly sessionDir: string | undefined;

	constructor(sessionDir: string | undefined) {
		this.sessionDir = sessionDir;
	}

	async markArchived(thread: WireThread): Promise<void> {
		const sidecarPath = sidecarPathForThread(thread);
		await writeFile(
			sidecarPath,
			`${JSON.stringify({ archivedAt: new Date().toISOString(), thread } satisfies ArchivedThreadRecord)}\n`,
			"utf8",
		);
	}

	async clearArchived(threadId: string): Promise<void> {
		const threads = await this.listArchivedThreads();
		await Promise.all(
			threads
				.filter((thread) => thread.id === threadId)
				.map((thread) => rm(sidecarPathForThread(thread), { force: true })),
		);
	}

	async isArchived(thread: WireThread): Promise<boolean> {
		try {
			await readFile(sidecarPathForThread(thread), "utf8");
			return true;
		} catch (error) {
			if (error instanceof Error) {
				return false;
			}
			throw error;
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
			if (error instanceof Error) {
				return [];
			}
			throw error;
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
		if (error instanceof Error) {
			return null;
		}
		throw error;
	}
	return parseArchivedThread(content);
}

function parseArchivedThread(content: string): WireThread | null {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		if (error instanceof Error) {
			return null;
		}
		throw error;
	}
	if (!isRecord(value) || !isRecord(value.thread)) {
		return null;
	}
	return parseWireThread(value.thread);
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
