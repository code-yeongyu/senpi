import {
	type Component,
	MouseRegion,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export function isQuestionMouseAction(event: TuiMouseEvent): boolean {
	return (
		event.button === "left" &&
		!event.shift &&
		!event.alt &&
		!event.ctrl &&
		(event.type === "press" || (event.type === "click" && event.clickCount === 1))
	);
}

/** The container records this region's committed row, including wrapped descriptions above it. */
export function questionMouseRegion(child: Component, onClick: () => void): MouseRegion {
	return new MouseRegion(child, (event) => {
		if (!isQuestionMouseAction(event) || event.y !== 0) return undefined;
		if (event.type === "click") onClick();
		return { handled: true, focus: true };
	});
}

/** Wrap between tabs and retain the exact emitted cell spans, never search for a label. */
export class AskUserQuestionTabs implements Component {
	private tabs: string[] = [];
	private hits: Array<{ index: number; row: number; start: number; end: number }> = [];
	private width = 0;
	private readonly onClick: (index: number) => void;
	constructor(onClick: (index: number) => void) {
		this.onClick = onClick;
	}
	setTabs(tabs: string[]): void {
		this.tabs = tabs;
	}
	invalidate(): void {}
	render(width: number): string[] {
		this.hits = [];
		this.width = width;
		if (width < 5) return [truncateToWidth("Use keys", width)];
		const lines: string[] = [];
		let line = " ";
		for (const [index, tab] of this.tabs.entries()) {
			const label = truncateToWidth(tab, width - 2);
			if (visibleWidth(line) > 1 && visibleWidth(line) + 2 + visibleWidth(label) > width - 1) {
				lines.push(line);
				line = " ";
			}
			if (visibleWidth(line) > 1) line += "  ";
			const start = visibleWidth(line);
			line += label;
			this.hits.push({ index, row: lines.length, start, end: visibleWidth(line) });
		}
		lines.push(line);
		return lines;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!isQuestionMouseAction(event) || event.width !== this.width) return undefined;
		const hit = this.hits.find((span) => event.y === span.row && event.x >= span.start && event.x < span.end);
		if (!hit) return undefined;
		if (event.type === "click") this.onClick(hit.index);
		return { handled: true, focus: true };
	}
}
