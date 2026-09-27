import {
	type Component,
	dispatchMouseEvent,
	renderChildrenTail,
	type TailRenderContext,
	type TailRenderResult,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";
import { applyBackgroundToLine, visibleWidth } from "../utils.ts";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;
	private disposed = false;

	// Cache for rendered output
	private cache?: RenderCache;
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
			component.dispose?.();
		}
	}

	clear(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
		this.children = [];
		this.invalidateCache();
	}

	detachAll(): void {
		this.children = [];
		this.invalidateCache();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const child of this.children) {
			child.dispose?.();
		}
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		const contentY = event.y - this.paddingY;
		const contentX = event.x - this.paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		const mouseChildren =
			this.mouseLayout?.width === contentWidth
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(contentWidth).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (contentY >= childY && contentY < childY + childHeight) {
				return dispatchMouseEvent(child, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
	}

	renderTail(width: number, maxRows: number, context: TailRenderContext): TailRenderResult {
		if (maxRows <= 0 || this.children.length === 0) return { lines: [], pending: false, hasMore: false };
		const paddingY = Math.max(0, Math.ceil(this.paddingY));
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const child = renderChildrenTail(this.children, contentWidth, Math.max(1, maxRows - paddingY), context);
		if (child.lines.length === 0 && !child.pending) return child;
		const top = child.hasMore ? 0 : Math.min(maxRows, paddingY);
		const omittedTop = child.hasMore ? paddingY : paddingY - top;
		const blank = this.applyBg("", width);
		const left = " ".repeat(this.paddingX);
		const decorated = [
			...new Array<string>(top).fill(blank),
			...child.lines.map((line) => this.applyBg(left + line, width)),
			...new Array<string>(Math.min(maxRows, paddingY)).fill(blank),
		];
		const clipped = Math.max(0, decorated.length - maxRows);
		const lines = decorated.slice(clipped);

		return {
			lines,
			pending: child.pending,
			hasMore: child.hasMore || omittedTop > 0 || paddingY > maxRows || clipped > 0,
		};
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children
		const childLines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}
		this.mouseLayout = { width: contentWidth, children: mouseChildren };

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample)) {
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
		this.cache = { childLines, width, bgSample, lines: result };

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
