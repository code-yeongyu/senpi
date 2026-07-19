import type { ThreadSearchParams, ThreadSearchResponse, ThreadSearchResult } from "../protocol/index.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import type { ThreadArchiveState } from "./archive-state.ts";
import { objectValue } from "./handler-params.ts";
import type { ThreadRegistry, WireThread } from "./registry.ts";
import { ThreadNotFoundError } from "./registry.ts";
import type { SearchSessionRecord, ThreadSearchCache } from "./search-cache.ts";
import type { TurnLog } from "./turn-log.ts";
import { buildWireThread } from "./wire-thread.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const APP_SERVER_SOURCE = "appServer";
type SearchSortKey = NonNullable<ThreadSearchParams["sortKey"]>;

export type ThreadSearchDependencies = {
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly archiveState: ThreadArchiveState;
	readonly cache: ThreadSearchCache;
};

type ParsedSearchParams = {
	readonly searchTerm: string;
	readonly cursor: string | null;
	readonly limit: number;
	readonly sortKey: SearchSortKey;
	readonly sortDirection: "asc" | "desc";
	readonly sourceKinds: readonly string[];
	readonly archived: boolean;
};

type SearchCursor = {
	readonly searchTerm: string;
	readonly sortKey: string;
	readonly sortDirection: "asc" | "desc";
	readonly sourceKinds: readonly string[];
	readonly archived: boolean;
	readonly anchorId: string;
	readonly includeAnchor: boolean;
};

export async function threadSearchResponse(
	requestParams: unknown,
	dependencies: ThreadSearchDependencies,
): Promise<ThreadSearchResponse> {
	const params = parseSearchParams(requestParams);
	const archivedIds = new Set((await dependencies.archiveState.listArchivedThreads()).map((thread) => thread.id));
	const records = await searchRecords(dependencies);
	const filtered = records.filter((record) => {
		const sourceMatches = params.sourceKinds.length === 0 || params.sourceKinds.includes(APP_SERVER_SOURCE);
		const archiveMatches = archivedIds.has(record.thread.id) === params.archived;
		return sourceMatches && archiveMatches && record.searchableText.toLocaleLowerCase().includes(params.searchTerm);
	});
	const sorted = filtered.sort((left, right) => compareRecords(left, right, params.sortKey, params.sortDirection));
	const cursor = params.cursor === null ? null : decodeCursor(params.cursor, params);
	const window = cursor ? cursorWindow(sorted, cursor) : sorted;
	const page = window.slice(0, params.limit);
	const nextCursor = window.length > page.length ? encodeCursor(page[page.length - 1], params, false) : null;
	const backwardsCursor = page.length > 0 ? encodeCursor(page[0], params, true) : null;
	const data = await Promise.all(page.map((record) => toSearchResult(record, params.searchTerm, dependencies)));
	return { data, nextCursor, backwardsCursor };
}

async function searchRecords(dependencies: ThreadSearchDependencies): Promise<SearchSessionRecord[]> {
	const byId = new Map<string, SearchSessionRecord>();
	for (const record of await dependencies.cache.load(dependencies.threads.getSessionDir())) {
		byId.set(record.thread.id, record);
	}
	for (const wireThread of dependencies.threads.listLoaded()) {
		const current = byId.get(wireThread.id);
		if (current) {
			byId.set(wireThread.id, { ...current, thread: wireThread });
			continue;
		}
		const record = loadedThreadRecord(dependencies.threads, wireThread);
		if (record) byId.set(wireThread.id, record);
	}
	return [...byId.values()];
}

function loadedThreadRecord(threads: ThreadRegistry, wireThread: WireThread): SearchSessionRecord | null {
	try {
		const entry = threads.getLoadedThread(wireThread.id);
		return {
			thread: wireThread,
			searchableText: entry.session
				.getUserMessagesForForking()
				.map((message) => message.text)
				.join(" "),
		};
	} catch (error: unknown) {
		if (error instanceof ThreadNotFoundError) return null;
		throw error;
	}
}

async function toSearchResult(
	record: SearchSessionRecord,
	searchTerm: string,
	dependencies: ThreadSearchDependencies,
): Promise<ThreadSearchResult> {
	let thread = await buildWireThread(record.thread, dependencies.turnLog, false);
	try {
		const loaded = dependencies.threads.getLoadedThread(record.thread.id);
		thread = await buildWireThread(loaded, dependencies.turnLog, false);
	} catch (error: unknown) {
		if (!(error instanceof ThreadNotFoundError)) throw error;
	}
	return { thread, snippet: literalSnippet(record.searchableText, searchTerm) };
}

function parseSearchParams(value: unknown): ParsedSearchParams {
	const params = objectValue(value);
	const rawTerm = params.searchTerm;
	if (typeof rawTerm !== "string" || rawTerm.trim().length === 0) {
		throw invalidSearch("thread/search requires a non-empty searchTerm");
	}
	const sortKey = readSortKey(params.sortKey);
	const sortDirection = readSortDirection(params.sortDirection);
	const sourceKinds = readSourceKinds(params.sourceKinds);
	return {
		searchTerm: rawTerm.trim().toLocaleLowerCase(),
		cursor: readCursor(params.cursor),
		limit: clampLimit(params.limit),
		sortKey,
		sortDirection,
		sourceKinds,
		archived: params.archived === true,
	};
}

function readSortKey(value: unknown): SearchSortKey {
	if (value === undefined || value === null) return "created_at";
	if (value === "created_at" || value === "updated_at" || value === "recency_at") return value;
	throw invalidSearch("thread/search received an invalid sortKey");
}

function readSortDirection(value: unknown): "asc" | "desc" {
	if (value === undefined || value === null) return "desc";
	if (value === "asc" || value === "desc") return value;
	throw invalidSearch("thread/search received an invalid sortDirection");
}

function readSourceKinds(value: unknown): readonly string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((source) => typeof source !== "string")) {
		throw invalidSearch("thread/search received an invalid sourceKinds");
	}
	return [...new Set(value)].sort();
}

function readCursor(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	throw invalidSearch("thread/search received an invalid cursor");
}

function clampLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_LIMIT;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw invalidSearch("thread/search received an invalid limit");
	}
	return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

function compareRecords(
	left: SearchSessionRecord,
	right: SearchSessionRecord,
	sortKey: SearchSortKey,
	direction: "asc" | "desc",
): number {
	const leftValue = sortValue(left.thread, sortKey);
	const rightValue = sortValue(right.thread, sortKey);
	if (leftValue !== rightValue) {
		return direction === "asc" ? leftValue - rightValue : rightValue - leftValue;
	}
	return direction === "asc"
		? left.thread.id.localeCompare(right.thread.id)
		: right.thread.id.localeCompare(left.thread.id);
}

function sortValue(thread: WireThread, sortKey: SearchSortKey): number {
	const field = sortKey === "created_at" ? thread.createdAt : thread.updatedAt;
	const parsed = Date.parse(field);
	return Number.isFinite(parsed) ? parsed : 0;
}

function cursorWindow(records: readonly SearchSessionRecord[], cursor: SearchCursor): readonly SearchSessionRecord[] {
	const anchorIndex = records.findIndex((record) => record.thread.id === cursor.anchorId);
	if (anchorIndex === -1) throw invalidSearch("thread/search received an invalid cursor anchor");
	if (cursor.includeAnchor) {
		return records.slice(anchorIndex);
	}
	return records.slice(anchorIndex + 1);
}

function decodeCursor(value: string, params: ParsedSearchParams): SearchCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error: unknown) {
		if (error instanceof SyntaxError) throw invalidSearch(`thread/search received an invalid cursor: ${value}`);
		throw error;
	}
	if (!isSearchCursor(parsed)) throw invalidSearch(`thread/search received an invalid cursor: ${value}`);
	if (
		parsed.searchTerm !== params.searchTerm ||
		parsed.sortKey !== params.sortKey ||
		parsed.archived !== params.archived ||
		parsed.sourceKinds.join("\u0000") !== params.sourceKinds.join("\u0000")
	) {
		throw invalidSearch("thread/search cursor does not match the requested search");
	}
	const directionMatches = parsed.sortDirection === params.sortDirection;
	if (parsed.includeAnchor ? directionMatches : !directionMatches) {
		throw invalidSearch("thread/search cursor does not match the requested sort direction");
	}
	return parsed;
}

function encodeCursor(
	record: SearchSessionRecord | undefined,
	params: ParsedSearchParams,
	includeAnchor: boolean,
): string | null {
	if (!record) return null;
	return JSON.stringify({
		searchTerm: params.searchTerm,
		sortKey: params.sortKey,
		sortDirection: params.sortDirection,
		sourceKinds: params.sourceKinds,
		archived: params.archived,
		anchorId: record.thread.id,
		includeAnchor,
	} satisfies SearchCursor);
}

function isSearchCursor(value: unknown): value is SearchCursor {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = Object.fromEntries(Object.entries(value));
	return (
		typeof record.searchTerm === "string" &&
		typeof record.sortKey === "string" &&
		(record.sortDirection === "asc" || record.sortDirection === "desc") &&
		Array.isArray(record.sourceKinds) &&
		record.sourceKinds.every((source) => typeof source === "string") &&
		typeof record.archived === "boolean" &&
		typeof record.anchorId === "string" &&
		typeof record.includeAnchor === "boolean"
	);
}

function literalSnippet(text: string, term: string): string {
	const index = text.toLocaleLowerCase().indexOf(term);
	if (index < 0) return "";
	const start = Math.max(0, index - 80);
	const end = Math.min(text.length, index + term.length + 80);
	return `${start > 0 ? "... " : ""}${text.slice(start, end)}${end < text.length ? " ..." : ""}`;
}

function invalidSearch(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}
