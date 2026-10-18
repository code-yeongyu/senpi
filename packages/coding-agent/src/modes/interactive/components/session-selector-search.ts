import { fuzzyMatchLower } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

interface SessionSearchText {
	/** Original case, for the regex branch (its `i` flag handles case). */
	readonly text: string;
	/** Lower-cased once, for fuzzy tokens. */
	readonly lower: string;
	/** Whitespace-normalized lower case, built on the first phrase token. */
	normalized?: string;
}

/**
 * Search text per row object. A re-listed directory yields new `SessionInfo` objects, so a fresh
 * listing recomputes and the old rows' text is collected with them.
 */
const searchTextCache = new WeakMap<SessionInfo, SessionSearchText>();

function getSessionSearchText(session: SessionInfo): SessionSearchText {
	const cached = searchTextCache.get(session);
	if (cached) return cached;
	const text = `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
	const entry: SessionSearchText = { text, lower: text.toLowerCase() };
	searchTextCache.set(session, entry);
	return entry;
}

/** Query tokens with their per-query case folding done once, not once per session. */
type PreparedToken = { kind: "fuzzy"; lower: string } | { kind: "phrase"; normalized: string };

function prepareTokens(parsed: ParsedSearchQuery): PreparedToken[] {
	return parsed.tokens.map((token) =>
		token.kind === "phrase"
			? { kind: "phrase", normalized: normalizeWhitespaceLower(token.value) }
			: { kind: "fuzzy", lower: token.value.toLowerCase() },
	);
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	return matchPrepared(session, parsed, prepareTokens(parsed));
}

function matchPrepared(session: SessionInfo, parsed: ParsedSearchQuery, tokens: PreparedToken[]): MatchResult {
	const searchText = getSessionSearchText(session);

	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = searchText.text.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	if (tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;

	for (const token of tokens) {
		if (token.kind === "phrase") {
			searchText.normalized ??= normalizeWhitespaceLower(searchText.text);
			if (!token.normalized) continue;
			const idx = searchText.normalized.indexOf(token.normalized);
			if (idx < 0) return { matches: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		const m = fuzzyMatchLower(token.lower, searchText.lower);
		if (!m.matches) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];
	const tokens = prepareTokens(parsed);

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchPrepared(s, parsed, tokens);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchPrepared(s, parsed, tokens);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
