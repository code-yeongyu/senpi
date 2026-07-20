import type { ThreadSearchParams, ThreadSourceKind } from "../protocol/index.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import { objectValue } from "./handler-params.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_U32 = 0xffff_ffff;
const INTERACTIVE_SOURCE_KINDS = ["cli", "vscode"] as const satisfies readonly ThreadSourceKind[];
const THREAD_SOURCE_KINDS: ReadonlySet<string> = new Set([
	"cli",
	"vscode",
	"exec",
	"appServer",
	"subAgent",
	"subAgentReview",
	"subAgentCompact",
	"subAgentThreadSpawn",
	"subAgentOther",
	"unknown",
]);

export type SearchSortKey = NonNullable<ThreadSearchParams["sortKey"]>;

export type ParsedSearchParams = {
	readonly searchTerm: string;
	readonly cursor: string | null;
	readonly limit: number;
	readonly sortKey: SearchSortKey;
	readonly sortDirection: "asc" | "desc";
	readonly sourceKinds: readonly ThreadSourceKind[];
	readonly archived: boolean;
};

export function parseSearchParams(value: unknown): ParsedSearchParams {
	const params = objectValue(value);
	const rawTerm = params.searchTerm;
	if (typeof rawTerm !== "string" || rawTerm.trim().length === 0) {
		throw invalidSearch("thread/search requires a non-empty searchTerm");
	}
	return {
		searchTerm: rawTerm.trim().toLocaleLowerCase(),
		cursor: readCursor(params.cursor),
		limit: readLimit(params.limit),
		sortKey: readSortKey(params.sortKey),
		sortDirection: readSortDirection(params.sortDirection),
		sourceKinds: readSourceKinds(params.sourceKinds),
		archived: readArchived(params.archived),
	};
}

export function invalidSearch(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
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

function readSourceKinds(value: unknown): readonly ThreadSourceKind[] {
	if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
		return INTERACTIVE_SOURCE_KINDS;
	}
	if (!Array.isArray(value) || value.some((source) => !isThreadSourceKind(source))) {
		throw invalidSearch("thread/search received an invalid sourceKinds");
	}
	return [...new Set(value)].sort();
}

function isThreadSourceKind(value: unknown): value is ThreadSourceKind {
	return typeof value === "string" && THREAD_SOURCE_KINDS.has(value);
}

function readCursor(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	throw invalidSearch("thread/search received an invalid cursor");
}

function readLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_LIMIT;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_U32) {
		throw invalidSearch("thread/search received an invalid limit");
	}
	return Math.min(MAX_LIMIT, Math.max(1, value));
}

function readArchived(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "boolean") return value;
	throw invalidSearch("thread/search received an invalid archived flag");
}
