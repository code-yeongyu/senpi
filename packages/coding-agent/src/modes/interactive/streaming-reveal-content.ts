import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getGraphemeSegmenter } from "@earendil-works/pi-tui";

type AssistantContentBlock = AssistantMessage["content"][number];
export type GraphemeCounter = (index: number, text: string) => number;
export type GraphemeSlicer = (index: number, text: string, units: number) => string;

function countGraphemesFrom(text: string, start: number): { count: number; tailStart: number } {
	let count = 0;
	let tailStart = start;
	for (const segment of getGraphemeSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		tailStart = start + segment.index;
	}
	return { count, tailStart };
}

function segmentFrom(text: string, start: number, clusters: number): { count: number; end: number; lastStart: number } {
	let count = 0;
	let end = start;
	let lastStart = start;
	for (const segment of getGraphemeSegmenter().segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		lastStart = start + segment.index;
		end = lastStart + segment.segment.length;
		if (count >= clusters) break;
	}
	return { count, end, lastStart };
}

export class BlockUnitCounter {
	readonly #entries = new Map<number, { text: string; count: number; tailStart: number }>();
	readonly #sliceEntries = new Map<number, { text: string; units: number; end: number; lastStart: number }>();

	count(index: number, text: string): number {
		const entry = this.#entries.get(index);
		if (entry !== undefined) {
			if (entry.text === text) return entry.count;
			if (entry.count > 0 && text.length > entry.text.length && text.startsWith(entry.text)) {
				const tail = countGraphemesFrom(text, entry.tailStart);
				const next = { text, count: entry.count - 1 + tail.count, tailStart: tail.tailStart };
				this.#entries.set(index, next);
				return next.count;
			}
		}
		const full = countGraphemesFrom(text, 0);
		this.#entries.set(index, { text, count: full.count, tailStart: full.tailStart });
		return full.count;
	}

	slice(index: number, text: string, units: number): string {
		const wholeUnits = Math.floor(units);
		if (wholeUnits <= 0 || text.length === 0) return "";
		const entry = this.#sliceEntries.get(index);
		if (entry?.text === text && entry.units === wholeUnits) {
			return entry.end >= text.length ? text : text.slice(0, entry.end);
		}
		if (entry !== undefined && (entry.text === text || text.startsWith(entry.text)) && wholeUnits >= entry.units) {
			const segment = segmentFrom(text, entry.lastStart, wholeUnits - entry.units + 1);
			this.#sliceEntries.set(index, {
				text,
				units: entry.units - 1 + segment.count,
				end: segment.end,
				lastStart: segment.lastStart,
			});
			return segment.end >= text.length ? text : text.slice(0, segment.end);
		}
		const segment = segmentFrom(text, 0, wholeUnits);
		this.#sliceEntries.set(index, {
			text,
			units: segment.count,
			end: segment.end,
			lastStart: segment.lastStart,
		});
		return segment.end >= text.length ? text : text.slice(0, segment.end);
	}

	reset(): void {
		this.#entries.clear();
		this.#sliceEntries.clear();
	}
}

function countGraphemes(text: string): number {
	return countGraphemesFrom(text, 0).count;
}

function sliceGraphemes(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	const segment = segmentFrom(text, 0, units);
	return segment.end >= text.length ? text : text.slice(0, segment.end);
}

export function countVisibleUnits(message: AssistantMessage, hideThinking: boolean, countOf: GraphemeCounter): number {
	let total = 0;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block?.type === "text") {
			total += countOf(index, block.text ?? "");
		} else if (block?.type === "thinking" && !hideThinking) {
			total += countOf(index, block.thinking ?? "");
		}
	}
	return total;
}

export function visibleUnits(message: AssistantMessage, hideThinking: boolean): number {
	return countVisibleUnits(message, hideThinking, (_index, text) => countGraphemes(text));
}

export function buildDisplayMessage(
	target: AssistantMessage,
	revealed: number,
	hideThinking: boolean,
	countOf: GraphemeCounter = (_index, text) => countGraphemes(text),
	sliceOf: GraphemeSlicer = (_index, text, units) => sliceGraphemes(text, units),
): AssistantMessage {
	let remaining = Math.max(0, Math.floor(revealed));
	const content: AssistantContentBlock[] = [];
	for (let index = 0; index < target.content.length; index++) {
		const block = target.content[index];
		if (!block) continue;
		if (block.type === "text") {
			const text = block.text ?? "";
			const units = countOf(index, text);
			content.push(
				remaining <= 0
					? text.length === 0
						? block
						: { ...block, text: "" }
					: remaining >= units
						? block
						: { ...block, text: sliceOf(index, text, remaining) },
			);
			remaining = Math.max(0, remaining - units);
		} else if (block.type === "thinking" && !hideThinking) {
			const thinking = block.thinking ?? "";
			const units = countOf(index, thinking);
			content.push(
				remaining <= 0
					? thinking.length === 0
						? block
						: { ...block, thinking: "" }
					: remaining >= units
						? block
						: { ...block, thinking: sliceOf(index, thinking, remaining) },
			);
			remaining = Math.max(0, remaining - units);
		} else {
			content.push(block);
		}
	}
	return { ...target, content };
}
