import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private renderCache?: { width: number; lines: string[] };
	private renderRevision = 0;
	private renderInvalidationCallback: (() => void) | undefined;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		this.renderCache = undefined;
		this.renderRevision++;
		this.renderInvalidationCallback?.();
	}

	getRenderRevision(): number {
		return this.renderRevision;
	}

	getRenderChangeStart(): number {
		return 0;
	}

	setRenderInvalidationCallback(callback: (() => void) | undefined): void {
		this.renderInvalidationCallback = callback;
	}

	isRenderCacheTrackable(): boolean {
		return true;
	}

	render(width: number): string[] {
		if (this.renderCache?.width === width) {
			return this.renderCache.lines;
		}
		const lines = [this.color("─".repeat(Math.max(1, width)))];
		this.renderCache = { width, lines };
		return lines;
	}
}
