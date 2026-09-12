const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

interface PasteMarkerEntry {
	content: string;
	marker: string;
	lineCount: number;
	charCount: number;
}

export interface EditorPasteState {
	pastes: ReadonlyMap<number, string>;
	markers?: ReadonlyMap<number, string>;
	pasteCounter: number;
}

export interface PasteMarkerRemoval {
	text: string;
	removed: boolean;
}

function formatPasteMarker(id: number, lineCount: number, charCount: number): string {
	return lineCount > 10 ? `[paste #${id} +${lineCount} lines]` : `[paste #${id} ${charCount} chars]`;
}

function countLines(content: string): number {
	let lineCount = 1;
	for (let index = 0; index < content.length; index++) {
		if (content.charCodeAt(index) === 10) lineCount++;
	}
	return lineCount;
}

function createEntry(id: number, content: string, marker?: string): PasteMarkerEntry {
	const charCount = content.length;
	const parsed = marker?.match(PASTE_MARKER_SINGLE);
	const lineMatch = parsed?.[3]?.match(/^\+(\d+) lines$/);
	const lineCount = lineMatch ? Number.parseInt(lineMatch[1]!, 10) : countLines(content);
	const canonical = formatPasteMarker(id, lineCount, charCount);
	return { content, marker: marker === canonical ? marker : canonical, lineCount, charCount };
}

function countOccurrences(text: string, marker: string): number {
	let count = 0;
	let offset = 0;
	while (offset <= text.length - marker.length) {
		const index = text.indexOf(marker, offset);
		if (index === -1) break;
		count++;
		offset = index + marker.length;
	}
	return count;
}

function replaceSingleOccurrence(text: string, marker: string, replacement: string): string {
	const index = text.indexOf(marker);
	if (index === -1 || text.indexOf(marker, index + marker.length) !== -1) return text;
	return text.slice(0, index) + replacement + text.slice(index + marker.length);
}

function entriesFromState(state: EditorPasteState): Map<number, PasteMarkerEntry> {
	const entries = new Map<number, PasteMarkerEntry>();
	for (const [id, content] of state.pastes) {
		entries.set(id, createEntry(id, content, state.markers?.get(id)));
	}
	return entries;
}

export function expandPasteMarkers(text: string, state: EditorPasteState): string {
	const entries = entriesFromState(state);
	const byMarker = new Map<string, PasteMarkerEntry>();
	for (const entry of entries.values()) byMarker.set(entry.marker, entry);

	const matches: Array<{ end: number; marker: string; start: number }> = [];
	const counts = new Map<string, number>();
	for (const match of text.matchAll(PASTE_MARKER_REGEX)) {
		const marker = match[0];
		if (!byMarker.has(marker)) continue;
		matches.push({ start: match.index, end: match.index + marker.length, marker });
		counts.set(marker, (counts.get(marker) ?? 0) + 1);
	}
	if (matches.length === 0) return text;

	const chunks: string[] = [];
	let offset = 0;
	for (const match of matches) {
		chunks.push(text.slice(offset, match.start));
		const entry = byMarker.get(match.marker)!;
		chunks.push(counts.get(match.marker) === 1 ? entry.content : match.marker);
		offset = match.end;
	}
	chunks.push(text.slice(offset));
	return chunks.join("");
}

export function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

export function pasteMarkerId(segment: string): number | undefined {
	const match = segment.length >= 10 ? PASTE_MARKER_SINGLE.exec(segment) : null;
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/** Segments `text` treating every literal in `validMarkers` as a single atomic segment. */
export function segmentWithMarkers(
	text: string,
	baseSegmenter: Intl.Segmenter,
	validMarkers: ReadonlySet<string>,
): Iterable<Intl.SegmentData> {
	if (validMarkers.size === 0) return baseSegmenter.segment(text);

	const found: Array<{ start: number; end: number }> = [];
	for (const marker of validMarkers) {
		const start = text.indexOf(marker);
		if (start === -1) continue;
		found.push({ start, end: start + marker.length });
	}
	if (found.length === 0) return baseSegmenter.segment(text);
	found.sort((a, b) => a.start - b.start || b.end - a.end);

	// Nested/overlapping literals would desync the single-pass walk below; keep the outermost.
	const markers: Array<{ start: number; end: number }> = [];
	for (const range of found) {
		const previous = markers[markers.length - 1];
		if (previous && range.start < previous.end) continue;
		markers.push(range);
	}

	const result: Intl.SegmentData[] = [];
	let markerIndex = 0;
	let marker = markers[0];
	for (const segment of baseSegmenter.segment(text)) {
		while (marker && segment.index >= marker.end) marker = markers[++markerIndex];
		if (!marker || segment.index < marker.start) {
			result.push(segment);
		} else if (segment.index === marker.start) {
			result.push({ segment: text.slice(marker.start, marker.end), index: marker.start, input: text });
		}
	}
	return result;
}

/** Backward-compatible wrapper: paste markers are just one atomic marker set. */
export function segmentWithPasteMarkers(
	text: string,
	baseSegmenter: Intl.Segmenter,
	validMarkers: ReadonlySet<string>,
): Iterable<Intl.SegmentData> {
	return segmentWithMarkers(text, baseSegmenter, validMarkers);
}

export class PasteMarkerRegistry {
	private entries = new Map<number, PasteMarkerEntry>();
	private pasteCounter = 0;
	private metadataBuilds = 0;

	add(content: string, lineCount: number, charCount: number): string {
		const id = ++this.pasteCounter;
		const marker = formatPasteMarker(id, lineCount, charCount);
		this.entries.set(id, { content, marker, lineCount, charCount });
		this.metadataBuilds++;
		return marker;
	}

	authorizedMarkers(text: string): ReadonlySet<string> {
		const markers = new Set<string>();
		for (const entry of this.entries.values()) {
			if (countOccurrences(text, entry.marker) === 1) markers.add(entry.marker);
		}
		return markers;
	}

	clear(): void {
		this.entries.clear();
		this.pasteCounter = 0;
	}

	expand(text: string): string {
		return expandPasteMarkers(text, this.snapshot());
	}

	get metadataBuildCount(): number {
		return this.metadataBuilds;
	}

	install(state: EditorPasteState, text: string): void {
		this.entries = entriesFromState(state);
		this.metadataBuilds += this.entries.size;
		this.pasteCounter = Math.max(state.pasteCounter, ...this.entries.keys(), 0);
		this.prune(text);
	}

	prune(text: string, previousText?: string): void {
		for (const [id, entry] of this.entries) {
			const wasAuthorized = previousText === undefined || countOccurrences(previousText, entry.marker) === 1;
			if (!wasAuthorized || countOccurrences(text, entry.marker) !== 1) this.entries.delete(id);
		}
		this.pasteCounter = Math.max(...this.entries.keys(), 0);
	}

	remove(id: number, text: string): PasteMarkerRemoval {
		const removedEntry = this.entries.get(id);
		if (!removedEntry || !this.entries.delete(id)) return { text, removed: false };

		let updatedText = replaceSingleOccurrence(text, removedEntry.marker, "");
		const higherIds = [...this.entries.keys()].filter((entryId) => entryId > id).sort((a, b) => a - b);
		for (const oldId of higherIds) {
			const entry = this.entries.get(oldId)!;
			this.entries.delete(oldId);
			if (countOccurrences(updatedText, entry.marker) !== 1) continue;
			const newId = oldId - 1;
			const renamed = formatPasteMarker(newId, entry.lineCount, entry.charCount);
			updatedText = replaceSingleOccurrence(updatedText, entry.marker, renamed);
			this.entries.set(newId, { ...entry, marker: renamed });
		}
		this.pasteCounter = Math.max(...this.entries.keys(), 0);
		return { text: updatedText, removed: true };
	}

	snapshot(): EditorPasteState {
		const pastes = new Map<number, string>();
		const markers = new Map<number, string>();
		for (const [id, entry] of this.entries) {
			pastes.set(id, entry.content);
			markers.set(id, entry.marker);
		}
		return { pastes, markers, pasteCounter: this.pasteCounter };
	}

	restore(state: EditorPasteState): void {
		this.entries = entriesFromState(state);
		this.metadataBuilds += this.entries.size;
		this.pasteCounter = Math.max(state.pasteCounter, ...this.entries.keys(), 0);
	}
}
