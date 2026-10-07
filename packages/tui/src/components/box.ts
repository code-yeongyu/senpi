import {
	type Component,
	CompositeRevision,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";
import { applyBackgroundToLine, flattenLines, visibleWidth } from "../utils.ts";

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
	private readonly composite = new CompositeRevision();

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
		this.composite.bump();
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
		this.composite.bump();
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
		this.composite.bump();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/** Padding plus background over the children: exact `Box` instances change only with them (see `Container`). */
	getRenderRevision(): number | undefined {
		return Object.getPrototypeOf(this) === Box.prototype ? this.childRenderRevision() : undefined;
	}

	protected childRenderRevision(): number | undefined {
		return this.composite.read(this.children);
	}

	protected bumpRenderRevision(): void {
		this.composite.bump();
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

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children. Keep the child lines unpadded: children usually return the same string
		// objects every frame, so the cache check below is a cheap identity comparison per line.
		// Padding here would create new strings that must be compared character by character.
		const childLines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			for (const line of lines) {
				childLines.push(line);
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
			result.push(this.applyBg(leftPad + line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		flattenLines(result);
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
