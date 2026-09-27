import { Input } from "./components/input.ts";
import type { ScrollView } from "./components/scroll-view.ts";
import { getKeybindings } from "./keybindings.ts";
import type { ScrollEntryAnchor, ScrollEntryFrame, ScrollEntryRender, ScrollEntrySource } from "./layout-node.ts";
import type { Component, Focusable } from "./tui.ts";
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.ts";

const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
	textStart: number;
	textEnd: number;
	row: number;
	startCol: number;
	endCol: number;
	linearColumns: boolean;
}

interface SearchCorpus {
	text: string;
	spans: SearchSourceSpan[];
}

export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
	const chunks: string[] = [];
	const spans: SearchSourceSpan[] = [];
	let textLength = 0;
	let pendingSeparator = false;

	const appendSeparator = (): void => {
		if (!pendingSeparator) return;
		chunks.push(" ");
		textLength += 1;
		pendingSeparator = false;
	};

	for (let row = 0; row < lines.length; row++) {
		const line = stripTerminalSequences(lines[row] ?? "");
		let column = 0;

		// Rendered transcripts are overwhelmingly ASCII. Index complete non-space
		// runs at once instead of segmenting and allocating one mapping per cell.
		if (PRINTABLE_ASCII.test(line)) {
			let index = 0;
			while (index < line.length) {
				if (line.charCodeAt(index) === 0x20) {
					if (textLength > 0) pendingSeparator = true;
					column += 1;
					index += 1;
					continue;
				}
				let end = index + 1;
				while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
				appendSeparator();
				const text = line.slice(index, end);
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + text.length,
					linearColumns: true,
				});
				textLength += text.length;
				column += text.length;
				index = end;
			}
		} else {
			for (const grapheme of segmenter.segment(line)) {
				const text = grapheme.segment;
				const width = visibleWidth(text);
				if (/^\s+$/u.test(text)) {
					if (textLength > 0) pendingSeparator = true;
					column += width;
					continue;
				}
				appendSeparator();
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + width,
					linearColumns: false,
				});
				textLength += text.length;
				column += width;
			}
		}
		if (textLength > 0) pendingSeparator = true;
	}

	return { text: chunks.join(""), spans };
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSearchCorpusMatches(
	corpus: SearchCorpus,
	normalizedQuery: string,
	onMatchEnd?: (end: number) => void,
): AltScreenSearchMatch[] {
	if (!normalizedQuery) return [];
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	const matches: AltScreenSearchMatch[] = [];
	let spanIndex = 0;

	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		onMatchEnd?.(end);
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= start) spanIndex += 1;

		const segments: AltScreenSearchSegment[] = [];
		for (let index = spanIndex; index < corpus.spans.length; index++) {
			const span = corpus.spans[index]!;
			if (span.textStart >= end) break;
			if (span.textEnd <= start) continue;
			const startCol = span.linearColumns
				? span.startCol + Math.max(start, span.textStart) - span.textStart
				: span.startCol;
			const endCol = span.linearColumns ? span.startCol + Math.min(end, span.textEnd) - span.textStart : span.endCol;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, endCol);
			} else {
				segments.push({ row: span.row, startCol, endCol });
			}
		}
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= end) spanIndex += 1;
		if (segments.length > 0) matches.push({ segments });
	}

	return matches;
}

export interface AltScreenSearchResult {
	matches: AltScreenSearchMatch[];
	changed: boolean;
}

/** Cache the searchable corpus and matches while rendered transcript lines remain unchanged. */
export class AltScreenSearchIndex {
	private sourceLines: string[] | undefined;
	private corpus: SearchCorpus | undefined;
	private normalizedQuery: string | undefined;
	private matches: AltScreenSearchMatch[] = [];

	search(lines: readonly string[], query: string): AltScreenSearchResult {
		let sourceChanged = this.sourceLines?.length !== lines.length;
		if (!sourceChanged && this.sourceLines) {
			for (let index = 0; index < lines.length; index++) {
				if (this.sourceLines[index] === lines[index]) continue;
				sourceChanged = true;
				break;
			}
		}
		if (sourceChanged || !this.corpus) {
			this.sourceLines = Array.from(lines);
			this.corpus = buildSearchCorpus(lines);
		}

		const normalizedQuery = normalizeQuery(query);
		const changed = sourceChanged || normalizedQuery !== this.normalizedQuery;
		if (changed) {
			this.normalizedQuery = normalizedQuery;
			this.matches = findSearchCorpusMatches(this.corpus, normalizedQuery);
		}
		return { matches: this.matches, changed };
	}
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	const normalizedQuery = normalizeQuery(query);
	return normalizedQuery ? findSearchCorpusMatches(buildSearchCorpus(lines), normalizedQuery) : [];
}

export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

export interface IndexedAltScreenSearchSegment {
	anchor: ScrollEntryAnchor;
	/** Rendered-row witness for validating mutable entries before highlight or reveal. */
	readonly line: string;
	startCol: number;
	endCol: number;
}

export interface IndexedAltScreenSearchMatch {
	segments: IndexedAltScreenSearchSegment[];
}

export interface IndexedAltScreenSearchResult {
	matches: readonly IndexedAltScreenSearchMatch[];
	changed: boolean;
	pending: boolean;
	error?: string;
}

interface IndexedSearchSnapshot {
	view: Pick<ScrollView, "entrySource" | "renderEntry">;
	source: ScrollEntrySource | undefined;
	version: number;
	displayRevision: number;
	length: number;
	width: number;
	query: string;
}

interface IndexedSearchJob extends IndexedSearchSnapshot {
	source: ScrollEntrySource;
	onUpdate: () => void;
	resolve: () => void;
	nextEntry: number;
	rendered?: ScrollEntryRender;
	localRow: number;
	nextRow: number;
	anchors: Map<number, { anchor: ScrollEntryAnchor; line: string }>;
	carry: SearchCorpus;
	seenText: boolean;
	lastSourceIndex: number;
	checkpoint?: IndexedSearchCheckpoint;
	rollbackTo?: number;
}

/** Only the latest entry needs a checkpoint for the common streaming-tail update. */
interface IndexedSearchCheckpoint {
	index: number;
	sourceIndex: number;
	nextRow: number;
	anchors: IndexedSearchJob["anchors"];
	carry: SearchCorpus;
	seenText: boolean;
	matchCount: number;
}

interface IndexedVisibleSegment {
	matchIndex: number;
	segment: IndexedAltScreenSearchSegment;
}

const entrySearchKeys = new WeakMap<object, number>();
let nextEntrySearchKey = 0;

export function getIndexedAltScreenSearchMatchKey(match: IndexedAltScreenSearchMatch): string {
	const key = (segment: IndexedAltScreenSearchSegment): string => {
		let id = entrySearchKeys.get(segment.anchor.key);
		if (id === undefined) {
			id = nextEntrySearchKey++;
			entrySearchKeys.set(segment.anchor.key, id);
		}
		return `${id}:${segment.anchor.row}`;
	};
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${key(first)}:${first.startCol}:${key(last)}:${last.endCol}` : "";
}

/** Search entries only while a query is active; normal frames inspect the source's revision gates. */
export class IndexedAltScreenSearchIndex {
	private snapshot: IndexedSearchSnapshot | undefined;
	private job: IndexedSearchJob | undefined;
	private completed: IndexedSearchJob | undefined;
	private scheduled: ReturnType<typeof setImmediate> | undefined;
	private idle: Promise<void> = Promise.resolve();
	private matches: IndexedAltScreenSearchMatch[] = [];
	private visible = new Map<object, Map<number, IndexedVisibleSegment[]>>();
	private publication = 0;
	private observedPublication = 0;
	private error: string | undefined;

	search(
		view: Pick<ScrollView, "entrySource" | "renderEntry">,
		width: number,
		query: string,
		onUpdate: () => void,
	): IndexedAltScreenSearchResult {
		const source = view.entrySource;
		const normalizedQuery = normalizeQuery(query);
		const previous = this.snapshot;
		const sameQuery =
			previous?.view === view &&
			previous.source === source &&
			previous.width === width &&
			previous.query === normalizedQuery &&
			previous.displayRevision === source?.displayRevision;
		if (sameQuery && source && previous.version !== source.version) {
			this.retainPrefix(source, onUpdate);
		}
		const current = this.snapshot;
		if (
			!current ||
			current.view !== view ||
			current.source !== source ||
			current.width !== width ||
			current.query !== normalizedQuery ||
			current.version !== (source?.version ?? 0) ||
			current.displayRevision !== (source?.displayRevision ?? 0) ||
			current.length !== (source?.length ?? 0)
		) {
			this.cancel();
			this.publication++;
			const snapshot = {
				view,
				source,
				width,
				query: normalizedQuery,
				version: source?.version ?? 0,
				displayRevision: source?.displayRevision ?? 0,
				length: source?.length ?? 0,
			};
			this.snapshot = snapshot;
			if (source && normalizedQuery && source.length > 0) {
				this.idle = new Promise<void>((resolve) => {
					this.job = {
						...snapshot,
						source,
						onUpdate,
						resolve,
						nextEntry: 0,
						localRow: 0,
						nextRow: 0,
						anchors: new Map(),
						carry: { text: "", spans: [] },
						seenText: false,
						lastSourceIndex: -1,
					};
				});
				this.schedule();
			}
		} else if (this.job) {
			this.job.onUpdate = onUpdate;
		}
		const changed = this.observedPublication !== this.publication;
		this.observedPublication = this.publication;
		return {
			matches: this.job?.rollbackTo === undefined ? this.matches : [],
			changed,
			pending: this.job !== undefined,
			error: this.error,
		};
	}

	cancel(): void {
		if (this.scheduled !== undefined) clearImmediate(this.scheduled);
		this.scheduled = undefined;
		this.job?.resolve();
		this.job = undefined;
		this.completed = undefined;
		this.snapshot = undefined;
		this.matches = [];
		this.visible.clear();
		this.error = undefined;
	}

	whenIdle(): Promise<void> {
		return this.idle;
	}

	getVisibleMatches(frame: ScrollEntryFrame): readonly (IndexedVisibleSegment & { row: number })[] {
		const snapshot = this.snapshot;
		if (
			!snapshot ||
			snapshot.source !== frame.source ||
			snapshot.width !== frame.width ||
			snapshot.version !== frame.version ||
			snapshot.displayRevision !== frame.displayRevision
		)
			return [];
		const visible: (IndexedVisibleSegment & { row: number })[] = [];
		for (let row = 0; row < frame.rows.length; row++) {
			const committed = frame.rows[row];
			if (!committed) continue;
			for (const segment of this.visible.get(committed.anchor.key)?.get(committed.anchor.row) ?? []) {
				if (segment.segment.line !== committed.line || segment.matchIndex >= (this.job?.rollbackTo ?? Infinity))
					continue;
				visible.push({ ...segment, row });
			}
		}
		return visible;
	}

	private schedule(): void {
		this.scheduled = setImmediate(() => this.pump());
	}

	private retainPrefix(source: ScrollEntrySource, onUpdate: () => void): void {
		const saved = this.job ?? this.completed;
		if (!saved) return;
		const changed = source.changedSince?.(saved.version);
		if (changed === undefined) return;
		if (this.job && changed > saved.lastSourceIndex && saved.nextEntry <= source.length) {
			Object.assign(saved, { version: source.version, length: source.length, onUpdate });
			Object.assign(this.snapshot!, { version: source.version, length: source.length });
			return;
		}
		const checkpoint = saved.checkpoint;
		if (!checkpoint || changed < checkpoint.sourceIndex || checkpoint.index >= source.length) return;
		if (this.scheduled !== undefined) clearImmediate(this.scheduled);
		saved.resolve();
		this.completed = undefined;
		Object.assign(this.snapshot!, { version: source.version, length: source.length });
		this.idle = new Promise<void>((resolve) => {
			this.job = {
				...saved,
				version: source.version,
				length: source.length,
				onUpdate,
				resolve,
				nextEntry: checkpoint.index,
				rendered: undefined,
				localRow: 0,
				nextRow: checkpoint.nextRow,
				anchors: new Map(checkpoint.anchors),
				carry: checkpoint.carry,
				seenText: checkpoint.seenText,
				lastSourceIndex: checkpoint.sourceIndex,
				checkpoint,
				rollbackTo: checkpoint.matchCount,
			};
		});
		this.publication++;
		this.schedule();
	}

	private pauseStale(job: IndexedSearchJob): void {
		if (this.job !== job) return;
		this.job = undefined;
		this.completed = job;
		job.resolve();
	}

	private removeLastMatch(): void {
		const match = this.matches.pop()!;
		for (let index = match.segments.length - 1; index >= 0; index--) {
			const { anchor } = match.segments[index]!;
			const rows = this.visible.get(anchor.key)!;
			const matches = rows.get(anchor.row)!;
			matches.pop();
			if (matches.length === 0) rows.delete(anchor.row);
			if (rows.size === 0) this.visible.delete(anchor.key);
		}
	}

	private isCurrent(job: IndexedSearchJob): boolean {
		return (
			this.job === job &&
			job.view.entrySource === job.source &&
			job.source.version === job.version &&
			job.source.displayRevision === job.displayRevision &&
			job.source.length === job.length
		);
	}

	private pump(): void {
		this.scheduled = undefined;
		const job = this.job;
		if (!job) return;
		const previousCount = this.matches.length;
		const deadline = performance.now() + 8;
		try {
			// A legacy renderer and an individual rendered line remain synchronous units.
			// Bound work between those units, including empty entries, and release the event loop.
			for (let work = 0; work < 32 && performance.now() < deadline; work++) {
				if (!this.isCurrent(job)) {
					this.pauseStale(job);
					return;
				}
				if (job.rollbackTo !== undefined) {
					if (this.matches.length > job.rollbackTo) this.removeLastMatch();
					else job.rollbackTo = undefined;
					continue;
				}
				if (!job.rendered) {
					if (job.nextEntry === job.length) break;
					job.rendered = job.view.renderEntry(job.nextEntry++, job.width);
					job.localRow = 0;
					job.lastSourceIndex = job.rendered.entry.sourceIndex;
					job.checkpoint = {
						index: job.rendered.index,
						sourceIndex: job.lastSourceIndex,
						nextRow: job.nextRow,
						anchors: new Map(job.anchors),
						carry: job.carry,
						seenText: job.seenText,
						matchCount: this.matches.length,
					};
				} else if (job.localRow < job.rendered.lines.length) {
					this.appendRow(job, job.rendered.lines[job.localRow] ?? "");
					job.localRow++;
				} else {
					job.rendered = undefined;
				}
			}
		} catch {
			if (!this.isCurrent(job)) {
				this.pauseStale(job);
				return;
			}
			this.error = "Search unavailable";
			this.matches = [];
			this.visible.clear();
			this.job = undefined;
			this.completed = undefined;
			job.resolve();
			this.publication++;
			job.onUpdate();
			return;
		}
		if (this.job && !this.isCurrent(job)) {
			this.pauseStale(job);
			return;
		}
		if (!job.rendered && job.nextEntry === job.length) {
			this.completed = job;
			this.job = undefined;
		}
		if (!this.job) job.resolve();
		if (this.matches.length !== previousCount || !this.job) {
			this.publication++;
			job.onUpdate();
		}
		if (this.job === job) this.schedule();
	}

	private appendRow(job: IndexedSearchJob, line: string): void {
		const rowCorpus = buildSearchCorpus([line]);
		if (!rowCorpus.text) return;
		const row = job.nextRow++;
		const entry = job.rendered!.entry;
		job.anchors.set(row, { anchor: { key: entry.key, sourceIndex: entry.sourceIndex, row: job.localRow }, line });
		const separator = job.seenText ? " " : "";
		job.seenText = true;
		const offset = job.carry.text.length + separator.length;
		const corpus: SearchCorpus = {
			text: job.carry.text + separator + rowCorpus.text,
			spans: [
				...job.carry.spans,
				...rowCorpus.spans.map((span) => ({
					...span,
					row,
					textStart: span.textStart + offset,
					textEnd: span.textEnd + offset,
				})),
			],
		};
		let lastMatchEnd = 0;
		for (const match of findSearchCorpusMatches(corpus, job.query, (end) => {
			lastMatchEnd = end;
		})) {
			const matchIndex = this.matches.length;
			const segments = match.segments.map(({ row: matchRow, startCol, endCol }) => ({
				...job.anchors.get(matchRow)!,
				startCol,
				endCol,
			}));
			this.matches.push({ segments });
			for (const segment of segments) {
				let rows = this.visible.get(segment.anchor.key);
				if (!rows) {
					rows = new Map();
					this.visible.set(segment.anchor.key, rows);
				}
				let matches = rows.get(segment.anchor.row);
				if (!matches) {
					matches = [];
					rows.set(segment.anchor.row, matches);
				}
				matches.push({ matchIndex, segment });
			}
		}
		// Never retain characters consumed by a previous match: RegExp's global
		// non-overlap rule must also hold for matches spanning two batches/entries.
		let start = Math.max(lastMatchEnd, corpus.text.length - job.query.length + 1, 0);
		if (start > lastMatchEnd && /[\uDC00-\uDFFF]/u.test(corpus.text[start] ?? "")) start--;
		const spans = corpus.spans
			.filter((span) => span.textEnd > start)
			.map((span) => ({
				...span,
				startCol: span.startCol + (span.linearColumns ? Math.max(0, start - span.textStart) : 0),
				textStart: Math.max(0, span.textStart - start),
				textEnd: span.textEnd - start,
			}));
		job.carry = { text: corpus.text.slice(start), spans };
		const retainedRows = new Set(spans.map((span) => span.row));
		for (const retained of job.anchors.keys()) if (!retainedRows.has(retained)) job.anchors.delete(retained);
	}
}

export class AltScreenSearchComponent implements Component, Focusable {
	private readonly input = new Input({
		prompt: " ",
		placeholder: "Find in transcript",
		placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
	});
	private readonly onQueryChange: (query: string) => void;
	private readonly navigationButtonStyle: (text: string, hovered: boolean) => string;
	private resultCount = 0;
	private resultIndex = -1;
	private pending = false;
	private searchError = false;
	private previousButtonStart = -1;
	private previousButtonEnd = -1;
	private nextButtonStart = -1;
	private nextButtonEnd = -1;
	private hoveredNavigationDirection: -1 | 1 | undefined;
	private _focused = false;

	constructor(
		onQueryChange: (query: string) => void,
		navigationButtonStyle: (text: string, hovered: boolean) => string = (text) => text,
	) {
		this.onQueryChange = onQueryChange;
		this.navigationButtonStyle = navigationButtonStyle;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	setResult(index: number, count: number, pending = false, error = false): void {
		this.resultIndex = index;
		this.resultCount = count;
		this.pending = pending;
		this.searchError = error;
	}

	getNavigationDirectionAt(row: number, column: number): -1 | 1 | undefined {
		if (row !== 2) return undefined;
		if (column >= this.previousButtonStart && column < this.previousButtonEnd) return -1;
		if (column >= this.nextButtonStart && column < this.nextButtonEnd) return 1;
		return undefined;
	}

	setHoveredNavigationDirection(direction: -1 | 1 | undefined): boolean {
		if (direction === this.hoveredNavigationDirection) return false;
		this.hoveredNavigationDirection = direction;
		return true;
	}

	handleInput(data: string): void {
		const previous = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query !== previous) this.onQueryChange(query);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const innerWidth = Math.max(0, safeWidth - 2);
		const formatKey = (key: string | undefined): string =>
			key
				? key
						.split("+")
						.map((part) => {
							if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
							return part.charAt(0).toUpperCase() + part.slice(1);
						})
						.join("+")
				: "Unbound";
		const keybindings = getKeybindings();
		const previousKey = formatKey(keybindings.getKeys("tui.altScreen.searchPrevious")[0]);
		const nextKey = formatKey(keybindings.getKeys("tui.altScreen.searchNext")[0]);
		const query = this.input.getValue();
		const result = !query
			? ""
			: this.searchError
				? "Search unavailable"
				: this.pending
					? "Searching…"
					: this.resultCount === 0
						? "No matches"
						: `${this.resultIndex + 1}/${this.resultCount}`;
		const resultSpace = Math.max(0, innerWidth - 3);
		const visibleResult = truncateToWidth(result, resultSpace, "");
		const resultText = visibleResult ? `\x1b[2m ${visibleResult} \x1b[22m` : "";
		const inputWidth = Math.max(0, innerWidth - visibleWidth(resultText));
		const inputLine = truncateToWidth(this.input.render(Math.max(1, inputWidth))[0] ?? "", inputWidth, "");
		const inputPadding = " ".repeat(Math.max(0, inputWidth - visibleWidth(inputLine)));
		const content = `${inputLine}${inputPadding}${resultText}`;

		let previousButton = `↑ ${previousKey}`;
		let nextButton = `↓ ${nextKey}`;
		let separator = " · ";
		const outerGapWidth = 1;
		const availableControlsWidth = Math.max(0, innerWidth - outerGapWidth * 2 - 1);
		let controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		if (controlsWidth > availableControlsWidth) {
			previousButton = "↑";
			nextButton = "↓";
			separator = " ";
			controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		}
		const showButtons = controlsWidth <= availableControlsWidth;
		const renderedButtons = showButtons
			? this.navigationButtonStyle(previousButton, this.hoveredNavigationDirection === -1) +
				separator +
				this.navigationButtonStyle(nextButton, this.hoveredNavigationDirection === 1)
			: "";
		const outerGapsWidth = showButtons ? outerGapWidth * 2 : 0;
		const rightRuleWidth = renderedButtons && innerWidth > controlsWidth + outerGapsWidth ? 1 : 0;
		const leftRuleWidth = Math.max(
			0,
			innerWidth - (showButtons ? controlsWidth : 0) - outerGapsWidth - rightRuleWidth,
		);
		const previousStart = 1 + leftRuleWidth + outerGapWidth;
		this.previousButtonStart = showButtons ? previousStart : -1;
		this.previousButtonEnd = showButtons ? previousStart + visibleWidth(previousButton) : -1;
		this.nextButtonStart = showButtons ? this.previousButtonEnd + visibleWidth(separator) : -1;
		this.nextButtonEnd = showButtons ? this.nextButtonStart + visibleWidth(nextButton) : -1;

		if (safeWidth === 1) return ["┌", "│", "└"];
		return [
			`┌${"─".repeat(innerWidth)}┐`,
			`│${content}│`,
			`└${"─".repeat(leftRuleWidth)}${renderedButtons ? " " : ""}${renderedButtons}${renderedButtons ? " " : ""}${"─".repeat(rightRuleWidth)}┘`,
		];
	}
}
