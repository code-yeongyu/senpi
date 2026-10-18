import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import type { SessionHeader, SessionInfo } from "./session-manager.ts";
import { readCachedSessionSummary, type SessionSummaryStore } from "./session-summary-cache.ts";
import { SessionSummaryIndex } from "./session-summary-index.ts";

export type SessionListProgress = (
	loaded: number,
	total: number,
	/** Sessions loaded so far, sorted by activity, when the lister publishes a partial list. */
	partialSessions?: readonly SessionInfo[],
) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;
/** Loaded-row counts between partial-list publications: one directory, and every directory. */
export const CURRENT_SESSION_LIST_PUBLISH_INTERVAL = 10;
export const ALL_SESSION_LIST_PUBLISH_INTERVAL = 100;

/** Newest activity first. */
export function sortSessionInfos(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

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
 * stat-keyed summary cache (or `store` on a cache miss) and stream nothing.
 */
export async function buildSessionInfo(filePath: string, store?: SessionSummaryStore): Promise<SessionInfo | null> {
	const cached = await readCachedSessionSummary(filePath, store);
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
		...(summary.repositoryIdentity ? { repositoryIdentity: summary.repositoryIdentity } : {}),
	};
}

async function buildSessionInfosWithConcurrency(
	files: readonly string[],
	onLoaded: (info: SessionInfo | null) => void,
	store: SessionSummaryStore | undefined,
	signal?: AbortSignal,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file, store)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded(results[index] ?? null);
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		// An aborted listing starts no further loads; the in-flight ones settle first.
		while (!signal?.aborted && nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size === 0) break;
		await Promise.race(inFlight);
	}
	signal?.throwIfAborted();

	return results;
}

/** Build picker rows for an explicit file list, dropping files that are not sessions. */
export async function listSessionInfos(
	files: readonly string[],
	onLoaded: (info: SessionInfo | null) => void,
	store?: SessionSummaryStore,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const results = await buildSessionInfosWithConcurrency(files, onLoaded, store, signal);
	const sessions: SessionInfo[] = [];
	for (const info of results) {
		if (info) sessions.push(info);
	}
	return sessions;
}

/**
 * Build picker rows for session files that all live in `dir`, served through
 * and then persisted into that directory's summary index.
 */
export async function listSessionFilesInDir(
	dir: string,
	files: readonly string[],
	onLoaded: (info: SessionInfo | null) => void,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const index = new SessionSummaryIndex(dir);
	const sessions = await listSessionInfos(files, onLoaded, index, signal);
	await index.persist(files);
	return sessions;
}

/** Build picker rows for every `.jsonl` file in one session directory. An aborted `signal` rejects. */
export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(dir)) return [];

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
		let loaded = 0;
		const partialSessions: SessionInfo[] = [];
		return await listSessionFilesInDir(
			dir,
			files,
			(info) => {
				loaded++;
				if (info) partialSessions.push(info);
				// Progressive pickers render the first row at once, then every few rows.
				const publish =
					loaded === 1 || loaded % CURRENT_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === files.length;
				onProgress?.(loaded, files.length, publish ? sortSessionInfos([...partialSessions]) : undefined);
			},
			signal,
		);
	} catch {
		signal?.throwIfAborted();
		// A directory that cannot be read contributes no picker rows.
		return [];
	}
}
