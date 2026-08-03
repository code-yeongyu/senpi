import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	private renderedLines: string[];
	private renderRevision = 0;
	private renderInvalidationCallback: (() => void) | undefined;

	constructor(lines: number = 1) {
		this.lines = lines;
		this.renderedLines = Array.from({ length: Math.max(0, Math.ceil(lines)) }, () => "");
	}

	setLines(lines: number): void {
		if (this.lines === lines) return;
		this.lines = lines;
		this.renderedLines = Array.from({ length: Math.max(0, Math.ceil(lines)) }, () => "");
		this.markRenderInvalidated();
	}

	invalidate(): void {
		this.markRenderInvalidated();
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

	render(_width: number): string[] {
		return this.renderedLines;
	}

	private markRenderInvalidated(): void {
		this.renderRevision++;
		this.renderInvalidationCallback?.();
	}
}
