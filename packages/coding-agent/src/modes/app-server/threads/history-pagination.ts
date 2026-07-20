import { RpcHandlerError } from "../rpc/errors.ts";

export type HistoryValue<T> = {
	readonly key: string;
	readonly value: T;
};

type HistoryKind = "turn" | "item";

type HistoryCursor = {
	readonly kind: HistoryKind;
	readonly threadId: string;
	readonly turnId: string | null;
	readonly sortDirection: "asc" | "desc" | null;
	readonly anchor: string;
	readonly includeAnchor: boolean;
};

type HistoryPage<T> = {
	readonly data: readonly T[];
	readonly nextCursor: string | null;
	readonly backwardsCursor: string | null;
};

type HistoryPaginationOptions = {
	readonly kind: HistoryKind;
	readonly threadId: string;
	readonly turnId: string | null;
	readonly limit: number;
	readonly sortDirection: "asc" | "desc";
	readonly cursor: string | null;
};

export function paginateHistory<T>(
	values: readonly HistoryValue<T>[],
	options: HistoryPaginationOptions,
): HistoryPage<T> {
	const cursor = options.cursor === null ? null : decodeCursor(options.cursor, options);
	const ordered = options.sortDirection === "asc" ? [...values] : [...values].reverse();
	const window = cursor === null ? ordered : windowFromCursor(ordered, cursor);
	const page = window.slice(0, options.limit);
	const hasMore = window.length > page.length;
	const nextCursor = hasMore
		? encodeCursor({ ...options, anchor: page[page.length - 1]?.key ?? "", includeAnchor: false })
		: null;
	const backwardsCursor =
		page.length > 0 ? encodeCursor({ ...options, anchor: page[0]?.key ?? "", includeAnchor: true }) : null;
	return {
		data: page.map((value) => value.value),
		nextCursor,
		backwardsCursor,
	};
}

export function invalidHistory(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

export function inclusiveTurnHistoryCursor(threadId: string, turnId: string): string {
	return encodeCursor({
		kind: "turn",
		threadId,
		turnId: null,
		sortDirection: null,
		anchor: turnId,
		includeAnchor: true,
	});
}

function windowFromCursor<T>(values: readonly HistoryValue<T>[], cursor: HistoryCursor): readonly HistoryValue<T>[] {
	const anchorIndex = values.findIndex((value) => value.key === cursor.anchor);
	if (anchorIndex < 0) throw invalidHistory("invalid cursor: anchor is no longer present");
	return values.slice(cursor.includeAnchor ? anchorIndex : anchorIndex + 1);
}

function encodeCursor(options: {
	readonly kind: HistoryKind;
	readonly threadId: string;
	readonly turnId: string | null;
	readonly sortDirection: "asc" | "desc" | null;
	readonly anchor: string;
	readonly includeAnchor: boolean;
}): string {
	return JSON.stringify({
		kind: options.kind,
		threadId: options.threadId,
		turnId: options.turnId,
		sortDirection: options.sortDirection,
		anchor: options.anchor,
		includeAnchor: options.includeAnchor,
	} satisfies HistoryCursor);
}

function decodeCursor(value: string, options: Omit<HistoryPaginationOptions, "limit" | "cursor">): HistoryCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error: unknown) {
		if (error instanceof SyntaxError) throw invalidHistory(`invalid cursor: ${value}`);
		throw error;
	}
	if (!isHistoryCursor(parsed)) throw invalidHistory(`invalid cursor: ${value}`);
	if (parsed.kind !== options.kind || parsed.threadId !== options.threadId || parsed.turnId !== options.turnId) {
		throw invalidHistory("invalid cursor: cursor is not scoped to this history request");
	}
	if (parsed.sortDirection !== null) {
		const directionMatches = parsed.sortDirection === options.sortDirection;
		if (parsed.includeAnchor ? directionMatches : !directionMatches) {
			throw invalidHistory("invalid cursor: cursor direction does not match the request");
		}
	}
	return parsed;
}

function isHistoryCursor(value: unknown): value is HistoryCursor {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = Object.fromEntries(Object.entries(value));
	return (
		(record.kind === "turn" || record.kind === "item") &&
		typeof record.threadId === "string" &&
		(record.turnId === null || typeof record.turnId === "string") &&
		(record.sortDirection === null || record.sortDirection === "asc" || record.sortDirection === "desc") &&
		typeof record.anchor === "string" &&
		typeof record.includeAnchor === "boolean"
	);
}
