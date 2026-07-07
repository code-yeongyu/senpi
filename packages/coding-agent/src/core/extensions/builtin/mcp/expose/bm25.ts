// Zero-dependency BM25 tool-search engine (todo 30).
//
// Ranks MCP tools by relevance of a free-text query against tokenised
// name + description, with a server-name field boost. A normalised exact-name
// match short-circuits BEFORE BM25 (hyphen/underscore/case-insensitive) so a
// query equal to a tool's own name always wins rank-1 even when raw BM25
// term-frequency would float noisier tools above it (codex #21503 regression
// class). Constants k1=0.9, b=0.4 are SPEC-verified.
//
// Ranking is deterministic: equal scores tie-break by ascending full name.

const BM25_K1 = 0.9;
const BM25_B = 0.4;

// Field weights applied to term frequency. Name tokens matter most; the server
// name gets a modest boost; description is the baseline signal.
const NAME_FIELD_WEIGHT = 3;
const SERVER_FIELD_WEIGHT = 2;
const DESCRIPTION_FIELD_WEIGHT = 1;

export interface Bm25Doc {
	/** Full senpi tool name, e.g. `mcp_docs_get-library-docs`. Returned in results. */
	readonly name: string;
	/** Bare MCP tool name, e.g. `get-library-docs`. Used for exact-name matching. */
	readonly toolName: string;
	readonly description?: string;
	readonly server: string;
}

export interface Bm25Result {
	readonly name: string;
	readonly score: number;
	readonly exact: boolean;
	readonly doc: Bm25Doc;
}

export interface Bm25SearchOptions {
	/** Restrict results to a single server (by server name). */
	readonly server?: string;
	/** Disable the exact-name short-circuit (used to prove BM25-alone behaviour). */
	readonly exactMatch?: boolean;
}

export interface Bm25Index {
	search(query: string, limit?: number, options?: Bm25SearchOptions): Bm25Result[];
}

interface IndexedDoc {
	readonly doc: Bm25Doc;
	readonly termFreq: ReadonlyMap<string, number>;
	readonly length: number;
	readonly normName: string;
	readonly normToolName: string;
}

const DEFAULT_LIMIT = 25;

export function buildBm25Index(docs: readonly Bm25Doc[]): Bm25Index {
	const indexed: IndexedDoc[] = docs.map(indexDoc);
	const docFreq = new Map<string, number>();
	for (const entry of indexed) {
		for (const term of entry.termFreq.keys()) {
			docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
		}
	}
	const totalLength = indexed.reduce((sum, entry) => sum + entry.length, 0);
	const avgLength = indexed.length === 0 ? 0 : totalLength / indexed.length;
	const docCount = indexed.length;

	return {
		search(query, limit = DEFAULT_LIMIT, options = {}): Bm25Result[] {
			const pool =
				options.server === undefined ? indexed : indexed.filter((entry) => entry.doc.server === options.server);
			const queryTerms = tokenizeToolText(query);
			if (queryTerms.length === 0) return [];

			const useExact = options.exactMatch !== false;
			const normQuery = normalizeToolName(query);
			const results: Bm25Result[] = [];
			for (const entry of pool) {
				const exact = useExact && normQuery.length > 0 && isExactNameMatch(entry, normQuery);
				const score = bm25Score(entry, queryTerms, docFreq, avgLength, docCount);
				if (!exact && score <= 0) continue;
				results.push({ doc: entry.doc, exact, name: entry.doc.name, score });
			}
			results.sort(compareResults);
			return results.slice(0, Math.max(0, limit));
		},
	};
}

function indexDoc(doc: Bm25Doc): IndexedDoc {
	const termFreq = new Map<string, number>();
	addField(termFreq, tokenizeToolText(doc.name), NAME_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.toolName), NAME_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.server), SERVER_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.description ?? ""), DESCRIPTION_FIELD_WEIGHT);
	let length = 0;
	for (const count of termFreq.values()) length += count;
	return {
		doc,
		length,
		normName: normalizeToolName(doc.name),
		normToolName: normalizeToolName(doc.toolName),
		termFreq,
	};
}

function addField(termFreq: Map<string, number>, tokens: readonly string[], weight: number): void {
	for (const token of tokens) {
		termFreq.set(token, (termFreq.get(token) ?? 0) + weight);
	}
}

function bm25Score(
	entry: IndexedDoc,
	queryTerms: readonly string[],
	docFreq: ReadonlyMap<string, number>,
	avgLength: number,
	docCount: number,
): number {
	let score = 0;
	const seen = new Set<string>();
	for (const term of queryTerms) {
		if (seen.has(term)) continue;
		seen.add(term);
		const tf = entry.termFreq.get(term);
		if (tf === undefined) continue;
		const idf = inverseDocFreq(docFreq.get(term) ?? 0, docCount);
		const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / (avgLength || 1));
		score += idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
	}
	return score;
}

function inverseDocFreq(termDocFreq: number, docCount: number): number {
	// BM25 idf with the standard +1 smoothing; clamped to be non-negative so a
	// term present in every doc never contributes a negative score.
	const value = Math.log(1 + (docCount - termDocFreq + 0.5) / (termDocFreq + 0.5));
	return value < 0 ? 0 : value;
}

function isExactNameMatch(entry: IndexedDoc, normQuery: string): boolean {
	return normQuery === entry.normName || normQuery === entry.normToolName;
}

function compareResults(left: Bm25Result, right: Bm25Result): number {
	if (left.exact !== right.exact) return left.exact ? -1 : 1;
	if (right.score !== left.score) return right.score - left.score;
	return left.name.localeCompare(right.name);
}

/** Tokenise a tool identifier or description into lowercase word tokens,
 * splitting snake_case, kebab-case and camelCase / PascalCase boundaries. */
export function tokenizeToolText(text: string): string[] {
	if (text.length === 0) return [];
	const withBoundaries = text
		// camelCase / PascalCase: insert a space at lower->Upper and Upper->UpperLower boundaries.
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	const tokens: string[] = [];
	for (const raw of withBoundaries.split(/[^a-zA-Z0-9]+/)) {
		if (raw.length === 0) continue;
		tokens.push(raw.toLowerCase());
	}
	return tokens;
}

/** Normalise a tool name for exact matching: lowercase, strip separators. */
export function normalizeToolName(name: string): string {
	return name.toLowerCase().replace(/[-_\s]+/g, "");
}
