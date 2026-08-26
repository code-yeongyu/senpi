import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import type { SessionHeader, SessionInfo } from "./session-manager.ts";
import { readCachedSessionSummary } from "./session-summary-cache.ts";

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

function resolveModified(activityTime: number | undefined, header: SessionHeader, mtime: Date): Date {
	if (typeof activityTime === "number" && activityTime > 0) return new Date(activityTime);
	const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
	return Number.isNaN(headerTime) ? mtime : new Date(headerTime);
}

/**
 * Build one picker row from a session file's exact summary.
 *
 * The summary is derived from every record in the file, so a row's name, first
 * message, message count, and activity time are exact regardless of where those
 * records sit. Repeat listings of an unchanged file are served from the
 * stat-keyed summary cache and deserialize nothing.
 */
export async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	const cached = await readCachedSessionSummary(filePath);
	if (!cached) return null;

	const { summary, mtime } = cached;
	const header = summary.header;

	return {
		path: filePath,
		id: header.id,
		cwd: typeof header.cwd === "string" ? header.cwd : "",
		name: summary.name,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified: resolveModified(summary.lastActivityTime, header, mtime),
		messageCount: summary.messageCount,
		firstMessage: summary.firstUserMessage || "(no messages)",
		allMessagesText: summary.allMessagesText,
	};
}

async function buildSessionInfosWithConcurrency(
	files: readonly string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

/** Build picker rows for an explicit file list, dropping files that are not sessions. */
export async function listSessionInfos(files: readonly string[], onLoaded: () => void): Promise<SessionInfo[]> {
	const results = await buildSessionInfosWithConcurrency(files, onLoaded);
	const sessions: SessionInfo[] = [];
	for (const info of results) {
		if (info) sessions.push(info);
	}
	return sessions;
}

/** Build picker rows for every `.jsonl` file in one session directory. */
export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	if (!existsSync(dir)) return [];

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
		const total = progressTotal ?? files.length;
		let loaded = 0;
		return await listSessionInfos(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
	} catch {
		// A directory that cannot be read contributes no picker rows.
		return [];
	}
}
