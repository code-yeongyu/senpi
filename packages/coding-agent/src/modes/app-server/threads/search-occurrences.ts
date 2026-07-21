import { Lexer } from "marked";
import type {
	ThreadSearchOccurrence,
	ThreadSearchOccurrencesResponse,
	ThreadSearchTextRange,
} from "../protocol/index.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import { objectValue } from "./handler-params.ts";
import { type ThreadHistoryDependencies, threadHistoryTurns } from "./history.ts";
import { inclusiveTurnHistoryCursor } from "./history-pagination.ts";
import type { LoggedTurn, WireItem } from "./turn-log.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;
const MAX_U32 = 0xffff_ffff;
const SNIPPET_CONTEXT_BEFORE_CHARS = 48;
const SNIPPET_CONTEXT_AFTER_CHARS = 96;

type ParsedParams = {
	readonly threadId: string;
	readonly searchTerm: string;
	readonly cursor: string | null;
	readonly limit: number;
};

type SearchCursor = {
	readonly threadId: string;
	readonly searchTerm: string;
	readonly candidateKey: string;
	readonly occurrenceIndex: number;
};

type MessageCandidate = {
	readonly key: string;
	readonly turnId: string;
	readonly itemId: string;
	readonly text: string;
};

type IndexedOccurrence = {
	readonly candidateKey: string;
	readonly occurrenceIndex: number;
	readonly value: ThreadSearchOccurrence;
};

type FoldSpan = {
	readonly lowerStart: number;
	readonly lowerEnd: number;
	readonly originalStart: number;
	readonly originalEnd: number;
};

export async function threadSearchOccurrencesResponse(
	requestParams: unknown,
	dependencies: ThreadHistoryDependencies,
): Promise<ThreadSearchOccurrencesResponse> {
	const params = parseParams(requestParams);
	const turns = await threadHistoryTurns(params.threadId, dependencies);
	const occurrences = collectOccurrences(visibleMessageCandidates(turns), params);
	const start = params.cursor === null ? 0 : cursorStart(occurrences, decodeCursor(params.cursor, params));
	const data = occurrences.slice(start, start + params.limit).map((occurrence) => occurrence.value);
	const next = occurrences[start + data.length];
	return {
		data,
		nextCursor: next
			? JSON.stringify({
					threadId: params.threadId,
					searchTerm: params.searchTerm,
					candidateKey: next.candidateKey,
					occurrenceIndex: next.occurrenceIndex,
				} satisfies SearchCursor)
			: null,
	};
}

function parseParams(value: unknown): ParsedParams {
	const params = objectValue(value);
	const threadId = params.threadId;
	if (typeof threadId !== "string" || threadId.length === 0) {
		throw invalidOccurrences("thread/searchOccurrences requires a non-empty threadId");
	}
	const searchTerm = params.searchTerm;
	if (typeof searchTerm !== "string" || searchTerm.trim().length === 0) {
		throw invalidOccurrences("thread/searchOccurrences requires a non-empty searchTerm");
	}
	return {
		threadId,
		searchTerm,
		cursor: parseCursor(params.cursor),
		limit: parseLimit(params.limit),
	};
}

function parseCursor(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	throw invalidOccurrences("thread/searchOccurrences received an invalid cursor");
}

function parseLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_LIMIT;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_U32) {
		throw invalidOccurrences("thread/searchOccurrences received an invalid limit");
	}
	return Math.min(MAX_LIMIT, Math.max(1, value));
}

function visibleMessageCandidates(turns: readonly LoggedTurn[]): MessageCandidate[] {
	return turns.flatMap((turn) => {
		const finalAgentIndex = turn.items.findLastIndex((item) => item.type === "agentMessage");
		return turn.items.flatMap((item, index) => {
			if (item.type !== "userMessage" && (item.type !== "agentMessage" || index !== finalAgentIndex)) return [];
			const itemId = item.id;
			if (typeof itemId !== "string" || itemId.length === 0) return [];
			const text = searchableText(item);
			if (text.length === 0) return [];
			return [{ key: `${turn.turnId}\u0000${itemId}`, turnId: turn.turnId, itemId, text }];
		});
	});
}

function searchableText(item: WireItem): string {
	if (item.type === "agentMessage") {
		return typeof item.text === "string" ? markdownToSearchText(item.text) : "";
	}
	const content = item.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((input) =>
			isRecord(input) && input.type === "text" && typeof input.text === "string" ? [input.text] : [],
		)
		.join("");
}

function collectOccurrences(candidates: readonly MessageCandidate[], params: ParsedParams): IndexedOccurrence[] {
	return candidates.flatMap((candidate) =>
		findLiteralRanges(candidate.text, params.searchTerm).map((range, occurrenceIndex) => ({
			candidateKey: candidate.key,
			occurrenceIndex,
			value: occurrence(candidate, range, params.threadId),
		})),
	);
}

function occurrence(
	candidate: MessageCandidate,
	matched: ThreadSearchTextRange,
	threadId: string,
): ThreadSearchOccurrence {
	const snippetStart = charStartBefore(candidate.text, matched.start, SNIPPET_CONTEXT_BEFORE_CHARS);
	const snippetEnd = charEndAfter(candidate.text, matched.end, SNIPPET_CONTEXT_AFTER_CHARS);
	const leadingEllipsis = snippetStart > 0;
	const trailingEllipsis = snippetEnd < candidate.text.length;
	const snippet = `${leadingEllipsis ? "... " : ""}${candidate.text.slice(snippetStart, snippetEnd)}${trailingEllipsis ? " ..." : ""}`;
	const start = (leadingEllipsis ? 4 : 0) + candidate.text.slice(snippetStart, matched.start).length;
	return {
		turnId: candidate.turnId,
		itemId: candidate.itemId,
		snippet,
		snippetMatchRange: { start, end: start + matched.end - matched.start },
		turnCursor: inclusiveTurnHistoryCursor(threadId, candidate.turnId),
	};
}

function findLiteralRanges(text: string, term: string): ThreadSearchTextRange[] {
	const lowercaseNeedle = term.toLowerCase();
	const lowercaseText = text.toLowerCase();
	const spans: FoldSpan[] = [];
	let lowercaseOffset = 0;
	let originalStart = 0;
	for (const character of text) {
		const folded = character.toLowerCase();
		spans.push({
			lowerStart: lowercaseOffset,
			lowerEnd: lowercaseOffset + folded.length,
			originalStart,
			originalEnd: originalStart + character.length,
		});
		lowercaseOffset += folded.length;
		originalStart += character.length;
	}

	const ranges: ThreadSearchTextRange[] = [];
	let offset = 0;
	for (;;) {
		const start = lowercaseText.indexOf(lowercaseNeedle, offset);
		if (start < 0) return ranges;
		const end = start + lowercaseNeedle.length;
		const first = spans.find((span) => span.lowerStart <= start && start < span.lowerEnd);
		const last = spans.find((span) => span.lowerStart < end && end <= span.lowerEnd);
		if (first && last) ranges.push({ start: first.originalStart, end: last.originalEnd });
		offset = end;
	}
}

function markdownToSearchText(markdown: string): string {
	return Lexer.lex(markdown.trim()).map(markdownTokenText).join(" ").split(/\s+/u).filter(Boolean).join(" ");
}

function markdownTokenText(value: unknown): string {
	if (!isRecord(value)) return "";
	const type = value.type;
	if (type === "br" || type === "hr" || type === "space") return " ";
	if (type === "code" || type === "codespan" || type === "escape" || type === "html") {
		return typeof value.text === "string" ? value.text : "";
	}
	if (type === "list" && Array.isArray(value.items)) return value.items.map(markdownTokenText).join(" ");
	if (type === "table") {
		const header = Array.isArray(value.header) ? value.header.map(markdownTokenText) : [];
		const rows = Array.isArray(value.rows)
			? value.rows.flatMap((row) => (Array.isArray(row) ? row.map(markdownTokenText) : []))
			: [];
		return [...header, ...rows].join(" ");
	}
	if (Array.isArray(value.tokens)) return value.tokens.map(markdownTokenText).join("");
	return typeof value.text === "string" ? value.text : "";
}

function decodeCursor(value: string, params: ParsedParams): SearchCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error: unknown) {
		if (error instanceof SyntaxError) throw invalidOccurrences(`invalid cursor: ${value}`);
		throw error;
	}
	if (!isSearchCursor(parsed) || parsed.threadId !== params.threadId || parsed.searchTerm !== params.searchTerm) {
		throw invalidOccurrences(`invalid cursor: ${value}`);
	}
	return parsed;
}

function cursorStart(occurrences: readonly IndexedOccurrence[], cursor: SearchCursor): number {
	const index = occurrences.findIndex(
		(occurrence) =>
			occurrence.candidateKey === cursor.candidateKey && occurrence.occurrenceIndex === cursor.occurrenceIndex,
	);
	if (index < 0) throw invalidOccurrences("invalid cursor: anchor is no longer present");
	return index;
}

function isSearchCursor(value: unknown): value is SearchCursor {
	return (
		isRecord(value) &&
		typeof value.threadId === "string" &&
		typeof value.searchTerm === "string" &&
		typeof value.candidateKey === "string" &&
		typeof value.occurrenceIndex === "number" &&
		Number.isInteger(value.occurrenceIndex) &&
		value.occurrenceIndex >= 0
	);
}

function charStartBefore(text: string, index: number, count: number): number {
	const prefix = text.slice(0, index);
	const characters = Array.from(prefix);
	return characters.slice(0, Math.max(0, characters.length - count - 1)).join("").length;
}

function charEndAfter(text: string, index: number, count: number): number {
	return index + Array.from(text.slice(index)).slice(0, count).join("").length;
}

function invalidOccurrences(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
