import type { MentionRange } from "../autocomplete.ts";

export interface EditorLineCursor {
	readonly pos: number;
	readonly marker: string;
	readonly drawFakeCursor: boolean;
}

export interface EditorLineRenderInput {
	readonly text: string;
	readonly mentions: readonly MentionRange[];
	readonly mentionStyle: (text: string) => string;
	readonly cursor: EditorLineCursor | undefined;
	readonly firstGrapheme: (text: string) => string;
}

export interface EditorLineRenderResult {
	readonly text: string;
	/** True when a fake cursor cell was appended past the text (adds one column). */
	readonly cursorAppended: boolean;
}

const FAKE_CURSOR_END = "\x1b[7m \x1b[0m";

function clampMentions(mentions: readonly MentionRange[], length: number): MentionRange[] {
	return mentions
		.map((range) => ({ start: Math.max(0, range.start), end: Math.min(length, range.end) }))
		.filter((range) => range.start < range.end);
}

function cutPoints(length: number, mentions: readonly MentionRange[], cursorGlyph: MentionRange | undefined): number[] {
	const cuts = new Set<number>([0, length]);
	for (const range of mentions) {
		cuts.add(range.start);
		cuts.add(range.end);
	}
	if (cursorGlyph) {
		cuts.add(cursorGlyph.start);
		cuts.add(cursorGlyph.end);
	}
	return [...cuts].sort((left, right) => left - right);
}

/**
 * Compose one visible editor row: mention ranges get `mentionStyle`, the
 * cursor grapheme gets reverse video, and every fragment is styled on its
 * own so the cursor's SGR reset cannot bleed into the rest of a mention.
 */
export function renderEditorLine(input: EditorLineRenderInput): EditorLineRenderResult {
	const { text, cursor } = input;
	const mentions = clampMentions(input.mentions, text.length);
	const cursorInText = cursor !== undefined && cursor.pos < text.length;
	const cursorGlyph =
		cursorInText && cursor.drawFakeCursor
			? { start: cursor.pos, end: cursor.pos + input.firstGrapheme(text.slice(cursor.pos)).length }
			: undefined;
	const points = cutPoints(text.length, mentions, cursorGlyph);

	let out = "";
	for (let index = 0; index < points.length - 1; index++) {
		const from = points[index] ?? 0;
		const to = points[index + 1] ?? from;
		if (cursorInText && from === cursor.pos) out += cursor.marker;
		const segment = text.slice(from, to);
		if (cursorGlyph && from === cursorGlyph.start) {
			out += `\x1b[7m${segment}\x1b[0m`;
		} else if (mentions.some((range) => from >= range.start && to <= range.end)) {
			out += input.mentionStyle(segment);
		} else {
			out += segment;
		}
	}

	if (cursor !== undefined && !cursorInText) {
		out += cursor.marker;
		if (cursor.drawFakeCursor) return { text: out + FAKE_CURSOR_END, cursorAppended: true };
	}
	return { text: out, cursorAppended: false };
}
