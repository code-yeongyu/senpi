import { Container } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth } from "../utils.ts";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	revision: number;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box extends Container {
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		super();
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		this.invalidateCache();
		this.markRenderInvalidated();
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined, revision: number): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.revision === revision &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	override invalidate(): void {
		this.invalidateCache();
		super.invalidate();
	}

	override render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;
		const revision = this.getRenderRevision();
		if (
			this.isRenderCacheTrackable() &&
			this.cache?.width === width &&
			this.cache.bgSample === bgSample &&
			this.cache.revision === revision
		) {
			return this.cache.lines;
		}

		// Flatten children through Container so unchanged descendants are not rendered.
		const childLines: string[] = [];
		for (const line of super.render(contentWidth)) {
			childLines.push(leftPad + line);
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample, revision)) {
			return this.cache!.lines;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		this.cache = { childLines, width, bgSample, revision, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}
