import {
	type Component,
	dispatchMouseEvent,
	renderComponentTail,
	type TailRenderContext,
	type TailRenderResult,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";

export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** Adds mouse handling to an existing component without changing its rendering. */
export class MouseRegion implements Component {
	private readonly child: Component;
	private readonly onMouse: MouseRegionHandler;

	constructor(child: Component, onMouse: MouseRegionHandler) {
		this.child = child;
		this.onMouse = onMouse;
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	renderTail(width: number, maxRows: number, context: TailRenderContext): TailRenderResult {
		return renderComponentTail(this.child, width, maxRows, context);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		const childResult = dispatchMouseEvent(this.child, event);
		return childResult ?? this.onMouse(event);
	}

	dispose(): void {
		this.child.dispose?.();
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
