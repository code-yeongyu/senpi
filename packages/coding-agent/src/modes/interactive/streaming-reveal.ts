import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getGraphemeSegmenter } from "@earendil-works/pi-tui";
import type { AssistantMessageComponent } from "./components/assistant-message.ts";

export const MIN_REVEAL_UNITS_PER_SEC = 90;
export const CATCHUP_WINDOW_MS = 267;
export const MIN_SMOOTH_FPS = 30;
export const MAX_SMOOTH_FPS = 120;
export const DEFAULT_SMOOTH_FPS = 60;

type AssistantContentBlock = AssistantMessage["content"][number];
type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent">;
type GraphemeCounter = (index: number, text: string) => number;
type GraphemeSlicer = (index: number, text: string, units: number) => string;

export type StreamingRevealControllerOptions = {
	readonly getSmoothStreaming: () => boolean;
	readonly getSmoothStreamingFps: () => number;
	readonly getHideThinkingBlock: () => boolean;
	readonly requestRender: () => void;
};

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

function countVisibleUnits(message: AssistantMessage, hideThinking: boolean, countOf: GraphemeCounter): number {
	let total = 0;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block?.type === "text") {
			total += countOf(index, block.text);
		} else if (block?.type === "thinking" && !hideThinking) {
			total += countOf(index, block.thinking);
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
			const units = countOf(index, block.text);
			content.push(
				remaining <= 0
					? block.text.length === 0
						? block
						: { ...block, text: "" }
					: remaining >= units
						? block
						: { ...block, text: sliceOf(index, block.text, remaining) },
			);
			remaining = Math.max(0, remaining - units);
		} else if (block.type === "thinking" && !hideThinking) {
			const units = countOf(index, block.thinking);
			content.push(
				remaining <= 0
					? block.thinking.length === 0
						? block
						: { ...block, thinking: "" }
					: remaining >= units
						? block
						: { ...block, thinking: sliceOf(index, block.thinking, remaining) },
			);
			remaining = Math.max(0, remaining - units);
		} else {
			content.push(block);
		}
	}
	return { ...target, content };
}

export function nextStep(backlog: number, dtMs: number): number {
	if (backlog <= 0) return 0;
	const dt = Math.min(Math.max(dtMs, 1), 100);
	const minStep = Math.max(1, Math.round((MIN_REVEAL_UNITS_PER_SEC * dt) / 1000));
	const catchup = Math.ceil((backlog * dt) / CATCHUP_WINDOW_MS);
	return Math.min(backlog, Math.max(minStep, catchup));
}

export class StreamingRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getSmoothStreamingFps: () => number;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #requestRender: () => void;
	readonly #unitCounter = new BlockUnitCounter();
	readonly #countOf = (index: number, text: string): number => this.#unitCounter.count(index, text);
	readonly #sliceOf = (index: number, text: string, units: number): string =>
		this.#unitCounter.slice(index, text, units);
	#target: AssistantMessage | undefined;
	#component: StreamingRevealComponent | undefined;
	#timer: NodeJS.Timeout | undefined;
	#timerFps: number | undefined;
	#revealed = 0;
	#lastTickAt = 0;
	#hideThinkingBlock = false;

	constructor(options: StreamingRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getSmoothStreamingFps = options.getSmoothStreamingFps;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#requestRender = options.requestRender;
	}

	begin(component: StreamingRevealComponent, message: AssistantMessage): void {
		this.stop();
		this.#component = component;
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#applyTarget();
	}

	setTarget(message: AssistantMessage): void {
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		if (this.#component) this.#applyTarget();
	}

	resyncVisibility(): void {
		if (!this.#target || !this.#component) return;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#revealed = Math.min(this.#revealed, this.#visibleUnits(this.#target));
		this.#applyTarget();
	}

	stop(): void {
		this.#stopTimer();
		this.#target = undefined;
		this.#component = undefined;
		this.#revealed = 0;
		this.#lastTickAt = 0;
		this.#unitCounter.reset();
	}

	#applyTarget(): void {
		const target = this.#target;
		const component = this.#component;
		if (!target || !component) return;
		const total = this.#visibleUnits(target);
		if (!this.#getSmoothStreaming() || target.content.some((block) => block.type === "toolCall")) {
			this.#revealed = total;
			this.#stopTimer();
			component.updateContent(target);
			return;
		}
		this.#revealed = Math.min(this.#revealed, total);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	#visibleUnits(message: AssistantMessage): number {
		return countVisibleUnits(message, this.#hideThinkingBlock, this.#countOf);
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		this.#component.updateContent(
			buildDisplayMessage(this.#target, this.#revealed, this.#hideThinkingBlock, this.#countOf, this.#sliceOf),
		);
	}

	#syncTimer(total: number): void {
		if (this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		this.#startTimer();
	}

	#startTimer(): void {
		const configuredFps = this.#getSmoothStreamingFps();
		const fps = Number.isFinite(configuredFps)
			? Math.min(MAX_SMOOTH_FPS, Math.max(MIN_SMOOTH_FPS, configuredFps))
			: DEFAULT_SMOOTH_FPS;
		if (this.#timer && this.#timerFps === fps) return;
		this.#stopTimer();
		this.#lastTickAt = performance.now();
		const timer = setInterval(() => this.#tick(), 1000 / fps);
		timer.unref();
		this.#timer = timer;
		this.#timerFps = fps;
	}

	#stopTimer(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#timerFps = undefined;
	}

	#tick(): void {
		const target = this.#target;
		if (!target || !this.#component) {
			this.stop();
			return;
		}
		const total = this.#visibleUnits(target);
		if (this.#revealed >= total) {
			this.#stopTimer();
			return;
		}
		const now = performance.now();
		this.#revealed = Math.min(total, this.#revealed + nextStep(total - this.#revealed, now - this.#lastTickAt));
		this.#lastTickAt = now;
		this.#renderCurrent();
		this.#requestRender();
		if (this.#revealed >= total) this.#stopTimer();
	}
}
