import type { Component, TailRenderContext, TailRenderResult } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	renderTail(_width: number, maxRows: number, _context: TailRenderContext): TailRenderResult {
		const count = Math.max(0, Math.ceil(this.lines));
		const length = Math.min(count, Math.max(0, Math.floor(maxRows)));
		return {
			lines: new Array<string>(length).fill(""),
			pending: false,
			hasMore: count > length,
		};
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.lines; i++) {
			result.push("");
		}
		return result;
	}
}
