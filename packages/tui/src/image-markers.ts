export const IMAGE_MARKER_REGEX = /\[Image #([1-9]\d*)\]/g;
export const IMAGE_MARKER_SINGLE = /^\[Image #([1-9]\d*)\]$/;

/** Registry state for transfer between editor instances; ids only, never image bytes. */
export interface EditorImageState {
	ids: readonly number[];
	imageCounter: number;
}

export interface ImageMarkerRemoval {
	text: string;
	removed: boolean;
}

export interface ImageMarkerCanonicalization {
	text: string;
	/** Original ids in reading order; index i became marker `[Image #${i + 1}]`. */
	order: number[];
}

export function formatImageMarker(id: number): string {
	return `[Image #${id}]`;
}

export function isImageMarker(segment: string): boolean {
	return segment.length >= 10 && IMAGE_MARKER_SINGLE.test(segment);
}

export function imageMarkerId(segment: string): number | undefined {
	const match = segment.length >= 10 ? IMAGE_MARKER_SINGLE.exec(segment) : null;
	return match ? Number.parseInt(match[1]!, 10) : undefined;
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

/**
 * Tracks the ids of atomic `[Image #N]` markers living in editor text.
 *
 * The registry deliberately stores NO image payload: the owner (interactive mode) keeps the bytes
 * keyed by id, and this class only guarantees that the visible numbers stay a contiguous
 * `1..k` sequence so the Nth marker in reading order maps to the Nth submitted image.
 */
export class ImageMarkerRegistry {
	private entries = new Set<number>();
	private imageCounter = 0;

	/** Registers the next id and returns its canonical marker. */
	add(): string {
		const id = ++this.imageCounter;
		this.entries.add(id);
		return formatImageMarker(id);
	}

	/** Registered markers occurring EXACTLY once in `text` - the only ones safe to treat as atomic. */
	authorizedMarkers(text: string): ReadonlySet<string> {
		const markers = new Set<string>();
		for (const id of this.entries) {
			const marker = formatImageMarker(id);
			if (countOccurrences(text, marker) === 1) markers.add(marker);
		}
		return markers;
	}

	/** Rewrites authorized markers to `1..k` in reading order, returning the original id order. */
	canonicalize(text: string): ImageMarkerCanonicalization {
		const order = this.ids(text);
		if (order.length === 0) return { text, order };

		const renumbered = new Map<number, number>();
		for (const [index, id] of order.entries()) renumbered.set(id, index + 1);
		const updatedText = text.replace(IMAGE_MARKER_REGEX, (marker) => {
			const id = imageMarkerId(marker);
			const newId = id === undefined ? undefined : renumbered.get(id);
			return newId === undefined ? marker : formatImageMarker(newId);
		});
		this.entries = new Set(order.map((_, index) => index + 1));
		this.imageCounter = this.entries.size;
		return { text: updatedText, order };
	}

	clear(): void {
		this.entries.clear();
		this.imageCounter = 0;
	}

	/** Registered, authorized ids in TEXT READING ORDER (not insertion order). */
	ids(text: string): number[] {
		const authorized = this.authorizedMarkers(text);
		const ordered: number[] = [];
		for (const match of text.matchAll(IMAGE_MARKER_REGEX)) {
			if (!authorized.has(match[0])) continue;
			ordered.push(Number.parseInt(match[1]!, 10));
		}
		return ordered;
	}

	install(state: EditorImageState, text: string): void {
		this.restore(state);
		this.prune(text);
	}

	prune(text: string, previousText?: string): void {
		for (const id of [...this.entries]) {
			const marker = formatImageMarker(id);
			const wasAuthorized = previousText === undefined || countOccurrences(previousText, marker) === 1;
			if (!wasAuthorized || countOccurrences(text, marker) !== 1) this.entries.delete(id);
		}
		this.imageCounter = Math.max(...this.entries, 0);
	}

	/** Deletes `id`'s marker from `text` and renumbers every higher id downward by one. */
	remove(id: number, text: string): ImageMarkerRemoval {
		if (!this.entries.delete(id)) return { text, removed: false };

		let updatedText = replaceSingleOccurrence(text, formatImageMarker(id), "");
		const higherIds = [...this.entries].filter((entryId) => entryId > id).sort((a, b) => a - b);
		for (const oldId of higherIds) {
			this.entries.delete(oldId);
			const marker = formatImageMarker(oldId);
			if (countOccurrences(updatedText, marker) !== 1) continue;
			const newId = oldId - 1;
			updatedText = replaceSingleOccurrence(updatedText, marker, formatImageMarker(newId));
			this.entries.add(newId);
		}
		this.imageCounter = Math.max(...this.entries, 0);
		return { text: updatedText, removed: true };
	}

	restore(state: EditorImageState): void {
		this.entries = new Set(state.ids);
		this.imageCounter = Math.max(state.imageCounter, ...this.entries, 0);
	}

	snapshot(): EditorImageState {
		return { ids: [...this.entries].sort((a, b) => a - b), imageCounter: this.imageCounter };
	}
}
