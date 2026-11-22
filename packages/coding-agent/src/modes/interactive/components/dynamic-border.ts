import { type Component, nextRenderRevision } from "@earendil-works/pi-tui";
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
	private revision = nextRenderRevision();

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		this.revision = nextRenderRevision();
	}

	/** A full-width rule in a fixed color function: only the width (and theme, via invalidate) varies. */
	getRenderRevision(): number {
		return this.revision;
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
