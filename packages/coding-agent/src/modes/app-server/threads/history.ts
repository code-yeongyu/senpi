import { loadEntriesFromFile, type SessionEntry, SessionManager } from "../../../core/session-manager.ts";
import type {
	ThreadItemEntry,
	ThreadItemsListResponse,
	ThreadTurnsListResponse,
	TurnItemsView,
} from "../protocol/index.ts";
import type { ThreadArchiveState } from "./archive-state.ts";
import { objectValue } from "./handler-params.ts";
import { type HistoryValue, invalidHistory, paginateHistory } from "./history-pagination.ts";
import type { ThreadEntry, ThreadRegistry, WireThread } from "./registry.ts";
import { ThreadNotFoundError } from "./registry.ts";
import type { LoggedTurn, TurnLog } from "./turn-log.ts";
import { loggedTurnToWireTurn, type ThreadHistorySource, turnsForEntry, wireItemToThreadItem } from "./wire-thread.ts";

const DEFAULT_TURNS_LIMIT = 25;
const MAX_TURNS_LIMIT = 100;
const DEFAULT_ITEMS_LIMIT = 25;
const MAX_ITEMS_LIMIT = 100;
const MAX_U32 = 0xffff_ffff;

export type ThreadHistoryDependencies = {
	readonly archiveState: ThreadArchiveState;
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
};

export async function threadTurnsListResponse(
	requestParams: unknown,
	dependencies: ThreadHistoryDependencies,
): Promise<ThreadTurnsListResponse> {
	const params = parseTurnsParams(requestParams);
	const entry = await historyThread(dependencies.threads, dependencies.archiveState, params.threadId);
	const turns = turnsForEntry(entry, dependencies.turnLog).map((turn) => ({
		key: turn.turnId,
		value: loggedTurnToWireTurn(turn, params.itemsView),
	}));
	const page = paginateHistory(turns, {
		kind: "turn",
		threadId: params.threadId,
		turnId: null,
		limit: params.limit,
		sortDirection: params.sortDirection,
		cursor: params.cursor,
	});
	return page;
}

export async function threadHistoryTurns(
	threadId: string,
	dependencies: ThreadHistoryDependencies,
): Promise<readonly LoggedTurn[]> {
	const entry = await historyThread(dependencies.threads, dependencies.archiveState, threadId);
	return turnsForEntry(entry, dependencies.turnLog);
}

export async function threadItemsListResponse(
	requestParams: unknown,
	dependencies: ThreadHistoryDependencies,
): Promise<ThreadItemsListResponse> {
	const params = parseItemsParams(requestParams);
	const entry = await historyThread(dependencies.threads, dependencies.archiveState, params.threadId);
	const items: HistoryValue<ThreadItemEntry>[] = [];
	for (const turn of turnsForEntry(entry, dependencies.turnLog)) {
		if (params.turnId !== null && params.turnId !== turn.turnId) continue;
		for (const item of turn.items) {
			const wireItem = wireItemToThreadItem(item);
			items.push({
				key: `${turn.turnId}\u0000${wireItem.id}`,
				value: { turnId: turn.turnId, item: wireItem },
			});
		}
	}
	const page = paginateHistory(items, {
		kind: "item",
		threadId: params.threadId,
		turnId: params.turnId,
		limit: params.limit,
		sortDirection: params.sortDirection,
		cursor: params.cursor,
	});
	return page;
}

type ParsedTurnsParams = {
	readonly threadId: string;
	readonly cursor: string | null;
	readonly limit: number;
	readonly sortDirection: "asc" | "desc";
	readonly itemsView: TurnItemsView;
};

type ParsedItemsParams = {
	readonly threadId: string;
	readonly turnId: string | null;
	readonly cursor: string | null;
	readonly limit: number;
	readonly sortDirection: "asc" | "desc";
};

function parseTurnsParams(value: unknown): ParsedTurnsParams {
	const params = objectValue(value);
	return {
		threadId: requiredHistoryString(params.threadId, "threadId"),
		cursor: optionalCursor(params.cursor),
		limit: clampLimit(params.limit, DEFAULT_TURNS_LIMIT, MAX_TURNS_LIMIT, "thread/turns/list"),
		sortDirection: parseSortDirection(params.sortDirection, "desc", "thread/turns/list"),
		itemsView: parseItemsView(params.itemsView),
	};
}

function parseItemsParams(value: unknown): ParsedItemsParams {
	const params = objectValue(value);
	return {
		threadId: requiredHistoryString(params.threadId, "threadId"),
		turnId: optionalNullableString(params.turnId, "turnId"),
		cursor: optionalCursor(params.cursor),
		limit: clampLimit(params.limit, DEFAULT_ITEMS_LIMIT, MAX_ITEMS_LIMIT, "thread/items/list"),
		sortDirection: parseSortDirection(params.sortDirection, "asc", "thread/items/list"),
	};
}

async function historyThread(
	threads: ThreadRegistry,
	archiveState: ThreadArchiveState,
	threadId: string,
): Promise<ThreadEntry | ThreadHistorySource | WireThread> {
	try {
		return threads.getLoadedThread(threadId);
	} catch (error: unknown) {
		if (!(error instanceof ThreadNotFoundError)) throw error;
	}
	const sessionDir = threads.getSessionDir();
	const sessions = sessionDir ? await SessionManager.listAll(sessionDir) : await SessionManager.listAll();
	const session = sessions.find((candidate) => candidate.id === threadId);
	if (session) {
		return {
			id: threadId,
			createdAt: session.created.toISOString(),
			entries: loadEntriesFromFile(session.path).filter((entry): entry is SessionEntry => entry.type !== "session"),
		};
	}
	const archivedThread = (await archiveState.listArchivedThreads()).find((thread) => thread.id === threadId);
	if (archivedThread) return archivedThread;
	throw invalidHistory(`thread not found: ${threadId}`);
}

function parseSortDirection(value: unknown, fallback: "asc" | "desc", method: string): "asc" | "desc" {
	if (value === undefined || value === null) return fallback;
	if (value === "asc" || value === "desc") return value;
	throw invalidHistory(`${method} received an invalid sortDirection`);
}

function parseItemsView(value: unknown): TurnItemsView {
	if (value === undefined || value === null) return "summary";
	if (value === "notLoaded" || value === "summary" || value === "full") return value;
	throw invalidHistory("thread/turns/list received an invalid itemsView");
}

function clampLimit(value: unknown, fallback: number, maximum: number, method: string): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_U32) {
		throw invalidHistory(`${method} received an invalid limit`);
	}
	return Math.min(maximum, Math.max(1, value));
}

function requiredHistoryString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw invalidHistory(`thread history requires a non-empty ${name}`);
	}
	return value;
}

function optionalNullableString(value: unknown, name: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	throw invalidHistory(`thread/items/list received an invalid ${name}`);
}

function optionalCursor(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	throw invalidHistory("thread history received an invalid cursor");
}
