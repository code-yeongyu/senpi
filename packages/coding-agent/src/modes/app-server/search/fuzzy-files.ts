import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { FuzzyFileSearchMatchType, FuzzyFileSearchResult } from "../protocol/fuzzy-search.ts";
import { addGitignoreScope, type IgnoreScope, isIgnored } from "./gitignore.ts";

export const FUZZY_SEARCH_MAX_DEPTH = 12;
export const FUZZY_SEARCH_MAX_VISITED_ENTRIES = 50_000;
export const FUZZY_SEARCH_RESULT_LIMIT = 50;

const FILENAME_MATCH_BONUS = 1_000_000;
const CHARACTER_MATCH_SCORE = 10;
const CONTIGUOUS_MATCH_BONUS = 20;
const BOUNDARY_MATCH_BONUS = 5;
const CANCELLATION_YIELD_INTERVAL = 256;

export type FuzzyFileEntry = {
	readonly root: string;
	readonly path: string;
	readonly matchType: FuzzyFileSearchMatchType;
	readonly fileName: string;
};

export type FuzzyTraversalOptions = {
	readonly signal?: AbortSignal;
	readonly maxDepth?: number;
	readonly maxVisitedEntries?: number;
};

type TraversalState = {
	visitedEntries: number;
	stopped: boolean;
};

type ScoredMatch = {
	readonly score: number;
	readonly indices: readonly number[];
};

type NormalizedText = {
	readonly value: string;
	readonly sourceIndices: readonly number[];
};

export async function collectFuzzyFileEntries(
	roots: readonly string[],
	options: FuzzyTraversalOptions = {},
): Promise<readonly FuzzyFileEntry[]> {
	const entries: FuzzyFileEntry[] = [];
	const state: TraversalState = { visitedEntries: 0, stopped: false };
	const maxDepth = options.maxDepth ?? FUZZY_SEARCH_MAX_DEPTH;
	const maxVisitedEntries = options.maxVisitedEntries ?? FUZZY_SEARCH_MAX_VISITED_ENTRIES;
	for (const root of roots) {
		if (options.signal?.aborted || state.stopped) break;
		const absoluteRoot = resolve(root);
		const rootStat = await readableStat(absoluteRoot);
		if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) continue;
		await walkDirectory({
			wireRoot: root,
			absoluteRoot,
			absoluteDirectory: absoluteRoot,
			depth: 0,
			matchers: [],
			entries,
			state,
			signal: options.signal,
			maxDepth,
			maxVisitedEntries,
		});
	}
	return entries;
}

export function rankFuzzyFileEntries(
	query: string,
	entries: readonly FuzzyFileEntry[],
): readonly FuzzyFileSearchResult[] {
	if (query.length === 0) return [];
	const results: FuzzyFileSearchResult[] = [];
	for (const entry of entries) {
		const filenameMatch = scoreSubsequence(entry.fileName, query);
		const pathMatch = filenameMatch ?? scoreSubsequence(entry.path, query);
		if (!pathMatch) continue;
		const filenameOffset = Array.from(entry.path).length - Array.from(entry.fileName).length;
		const indices = filenameMatch ? filenameMatch.indices.map((index) => index + filenameOffset) : pathMatch.indices;
		results.push({
			root: entry.root,
			path: entry.path,
			match_type: entry.matchType,
			file_name: entry.fileName,
			score: pathMatch.score + (filenameMatch ? FILENAME_MATCH_BONUS : 0),
			indices,
		});
	}
	results.sort(compareResults);
	return results.slice(0, FUZZY_SEARCH_RESULT_LIMIT);
}

async function walkDirectory(input: {
	readonly wireRoot: string;
	readonly absoluteRoot: string;
	readonly absoluteDirectory: string;
	readonly depth: number;
	readonly matchers: readonly IgnoreScope[];
	readonly entries: FuzzyFileEntry[];
	readonly state: TraversalState;
	readonly signal: AbortSignal | undefined;
	readonly maxDepth: number;
	readonly maxVisitedEntries: number;
}): Promise<void> {
	const matchers = await addGitignoreScope(input.matchers, input.absoluteDirectory);
	const directoryEntries = await readableDirectory(input.absoluteDirectory);
	directoryEntries.sort((left, right) => compareText(left.name, right.name));
	for (const directoryEntry of directoryEntries) {
		if (input.signal?.aborted || input.state.stopped) return;
		if (input.state.visitedEntries >= input.maxVisitedEntries) {
			input.state.stopped = true;
			return;
		}
		input.state.visitedEntries += 1;
		if (directoryEntry.name === ".git" || directoryEntry.name === "node_modules") continue;
		if (directoryEntry.isSymbolicLink()) continue;
		const isDirectory = directoryEntry.isDirectory();
		if (!isDirectory && !directoryEntry.isFile()) continue;
		const absolutePath = join(input.absoluteDirectory, directoryEntry.name);
		const relativePath = toPosixPath(relative(input.absoluteRoot, absolutePath));
		if (isIgnored(matchers, absolutePath, isDirectory)) continue;
		input.entries.push({
			root: input.wireRoot,
			path: relativePath,
			matchType: isDirectory ? "directory" : "file",
			fileName: basename(relativePath),
		});
		const entryDepth = input.depth + 1;
		if (isDirectory && entryDepth < input.maxDepth) {
			await walkDirectory({ ...input, absoluteDirectory: absolutePath, depth: entryDepth, matchers });
		}
		if (input.state.visitedEntries % CANCELLATION_YIELD_INTERVAL === 0) await yieldToEventLoop();
	}
}

function scoreSubsequence(candidate: string, query: string): ScoredMatch | undefined {
	const normalizedCandidate = normalizeText(candidate);
	const normalizedQuery = query.toLowerCase();
	const contiguousStart = normalizedCandidate.value.indexOf(normalizedQuery);
	const normalizedIndices: number[] = [];
	if (contiguousStart >= 0) {
		let cursor = contiguousStart;
		for (const character of normalizedQuery) {
			normalizedIndices.push(cursor);
			cursor += character.length;
		}
	} else {
		let cursor = 0;
		for (const character of normalizedQuery) {
			const matchIndex = normalizedCandidate.value.indexOf(character, cursor);
			if (matchIndex < 0) return undefined;
			normalizedIndices.push(matchIndex);
			cursor = matchIndex + character.length;
		}
	}
	const indices: number[] = [];
	for (const normalizedIndex of normalizedIndices) {
		const sourceIndex = normalizedCandidate.sourceIndices[normalizedIndex];
		if (sourceIndex === undefined) return undefined;
		if (indices.at(-1) !== sourceIndex) indices.push(sourceIndex);
	}
	const candidateCharacters = Array.from(candidate);
	let score = indices.length * CHARACTER_MATCH_SCORE;
	for (let index = 0; index < indices.length; index++) {
		const current = indices[index];
		if (current === undefined) continue;
		const previous = indices[index - 1];
		if (previous !== undefined && current === previous + 1) score += CONTIGUOUS_MATCH_BONUS;
		if (current === 0 || isBoundary(candidateCharacters[current - 1])) score += BOUNDARY_MATCH_BONUS;
	}
	return { score, indices };
}

function normalizeText(value: string): NormalizedText {
	const sourceIndices: number[] = [];
	for (const [sourceIndex, character] of Array.from(value).entries()) {
		for (let index = 0; index < character.toLowerCase().length; index++) sourceIndices.push(sourceIndex);
	}
	return { value: value.toLowerCase(), sourceIndices };
}

function compareResults(left: FuzzyFileSearchResult, right: FuzzyFileSearchResult): number {
	if (left.score !== right.score) return right.score - left.score;
	return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function isBoundary(character: string | undefined): boolean {
	return character === "/" || character === "-" || character === "_" || character === "." || character === " ";
}

async function readableDirectory(path: string): Promise<Dirent[]> {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error: unknown) {
		if (error instanceof Error) return [];
		throw error;
	}
}

async function readableStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
	try {
		return await lstat(path);
	} catch (error: unknown) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
