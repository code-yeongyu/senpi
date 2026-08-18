import type { ToolSearchDocument, ToolSearchSource } from "./document.ts";

const BM25_K1 = 0.9;
const BM25_B = 0.4;

const NAME_FIELD_WEIGHT = 3;
const GROUP_FIELD_WEIGHT = 2;
const DESCRIPTION_FIELD_WEIGHT = 1;

export interface Bm25Result {
	readonly name: string;
	readonly score: number;
	readonly exact: boolean;
	readonly doc: ToolSearchDocument;
}

export interface Bm25SearchOptions {
	readonly source?: ToolSearchSource;
	readonly group?: string;
	/** Disable the exact-name short-circuit (used to prove BM25-alone behaviour). */
	readonly exactMatch?: boolean;
}

export interface Bm25Index {
	search(query: string, limit?: number, options?: Bm25SearchOptions): Bm25Result[];
}

interface IndexedDoc {
	readonly doc: ToolSearchDocument;
	readonly termFreq: ReadonlyMap<string, number>;
	readonly length: number;
	readonly exactNames: ReadonlySet<string>;
}

const DEFAULT_LIMIT = 25;

export function buildBm25Index(docs: readonly ToolSearchDocument[]): Bm25Index {
	const indexed = docs.map(indexDoc);
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
			const pool = indexed.filter(
				(entry) =>
					(options.source === undefined || entry.doc.source === options.source) &&
					(options.group === undefined || entry.doc.group === options.group),
			);
			const queryTerms = tokenizeToolText(query);
			if (queryTerms.length === 0) return [];

			const useExact = options.exactMatch !== false;
			const normQuery = normalizeToolName(query);
			const results: Bm25Result[] = [];
			for (const entry of pool) {
				const exact = useExact && normQuery.length > 0 && entry.exactNames.has(normQuery);
				const score = bm25Score(entry, queryTerms, docFreq, avgLength, docCount);
				if (!exact && score <= 0) continue;
				results.push({ doc: entry.doc, exact, name: entry.doc.name, score });
			}
			results.sort(compareResults);
			return results.slice(0, Math.max(0, limit));
		},
	};
}

function indexDoc(doc: ToolSearchDocument): IndexedDoc {
	const termFreq = new Map<string, number>();
	addField(termFreq, tokenizeToolText(doc.name), NAME_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.label), NAME_FIELD_WEIGHT);
	for (const alias of doc.aliases) addField(termFreq, tokenizeToolText(alias), NAME_FIELD_WEIGHT);
	for (const keyword of doc.keywords) addField(termFreq, tokenizeToolText(keyword), NAME_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.group), GROUP_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.ownerLabel), GROUP_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.description ?? ""), DESCRIPTION_FIELD_WEIGHT);
	addField(termFreq, tokenizeToolText(doc.searchText ?? ""), DESCRIPTION_FIELD_WEIGHT);

	let length = 0;
	for (const count of termFreq.values()) length += count;
	return {
		doc,
		exactNames: new Set([doc.name, doc.label, ...doc.aliases, ...doc.keywords].map(normalizeToolName)),
		length,
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
	const value = Math.log(1 + (docCount - termDocFreq + 0.5) / (termDocFreq + 0.5));
	return value < 0 ? 0 : value;
}

function compareResults(left: Bm25Result, right: Bm25Result): number {
	if (left.exact !== right.exact) return left.exact ? -1 : 1;
	if (right.score !== left.score) return right.score - left.score;
	return left.name.localeCompare(right.name);
}

/** Tokenise searchable text into lowercase word tokens, splitting identifiers. */
export function tokenizeToolText(text: string): string[] {
	if (text.length === 0) return [];
	const withBoundaries = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	const tokens: string[] = [];
	for (const raw of withBoundaries.split(/[^a-zA-Z0-9]+/)) {
		if (raw.length === 0) continue;
		tokens.push(raw.toLowerCase());
	}
	return tokens;
}

/** Normalize a searchable name for separator- and case-insensitive exact matching. */
export function normalizeToolName(name: string): string {
	return name.toLowerCase().replace(/[-_\s]+/g, "");
}
