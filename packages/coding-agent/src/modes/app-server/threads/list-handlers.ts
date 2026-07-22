import type { ThreadListResponse, ThreadLoadedListResponse } from "../protocol/index.ts";
import type { ThreadArchiveState } from "./archive-state.ts";
import { decodeCursor, encodeCursor, objectValue, optionalNumber, optionalString } from "./handler-params.ts";
import type { ThreadRegistry, WireThread } from "./registry.ts";
import type { TurnLog } from "./turn-log.ts";
import { buildWireThread } from "./wire-thread.ts";

export type ThreadListDependencies = {
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly archiveState: ThreadArchiveState;
};

const DEFAULT_THREAD_LIST_LIMIT = 25;

export async function listThreadsResponse(
	requestParams: unknown,
	dependencies: ThreadListDependencies,
): Promise<ThreadListResponse> {
	const params = objectValue(requestParams);
	const page = await dependencies.threads.listThreads({
		cursor: optionalString(params.cursor) ?? null,
		limit: optionalNumber(params.limit) ?? DEFAULT_THREAD_LIST_LIMIT,
	});
	const archived = params.archived === true;
	const threads = archived ? await archivedListThreads(page.threads, dependencies.archiveState) : page.threads;
	const filtered = await filterByArchiveState(threads, archived, dependencies.archiveState);
	return {
		data: await Promise.all(filtered.map((thread) => buildWireThread(thread, dependencies.turnLog, false))),
		nextCursor: page.nextCursor,
		backwardsCursor: null,
	};
}

export function loadedThreadsResponse(requestParams: unknown, threads: ThreadRegistry): ThreadLoadedListResponse {
	const params = objectValue(requestParams);
	const cursor = decodeCursor(optionalString(params.cursor) ?? null);
	const limit = optionalNumber(params.limit) ?? Number.POSITIVE_INFINITY;
	const ids = threads.listLoaded().map((thread) => thread.id);
	const data = ids.slice(cursor, cursor + limit);
	const nextOffset = cursor + data.length;
	return {
		data,
		nextCursor: nextOffset < ids.length ? encodeCursor(nextOffset) : null,
	};
}

async function filterByArchiveState(
	threads: readonly WireThread[],
	archived: boolean,
	archiveState: ThreadArchiveState,
): Promise<WireThread[]> {
	const filtered: WireThread[] = [];
	for (const thread of threads) {
		if ((await archiveState.isArchived(thread)) === archived) {
			filtered.push(thread);
		}
	}
	return filtered;
}

async function archivedListThreads(
	listedThreads: readonly WireThread[],
	archiveState: ThreadArchiveState,
): Promise<WireThread[]> {
	const threadsById = new Map<string, WireThread>();
	for (const thread of listedThreads) {
		threadsById.set(thread.id, thread);
	}
	for (const thread of await archiveState.listArchivedThreads()) {
		threadsById.set(thread.id, thread);
	}
	return [...threadsById.values()];
}
