import type { Component } from "@earendil-works/pi-tui";
import { getGrokChromeTokens } from "./chrome-tokens.ts";
import { GROK_GLYPHS } from "./palette.ts";

export type GrokToolRowState = {
	readonly toolName: string;
	readonly isPartial: boolean;
	readonly result?: { readonly isError: boolean };
};

/** Single-line grok tool presentation with a stable guide column. */
export class GrokToolRow implements Component {
	private state: GrokToolRowState;

	constructor(state: GrokToolRowState) {
		this.state = state;
	}

	update(state: GrokToolRowState): void {
		this.state = state;
	}

	invalidate(): void {
		// Rendering is derived from current state and active-theme tokens.
	}

	render(_width: number): string[] {
		const tokens = getGrokChromeTokens();
		const marker = this.state.isPartial
			? tokens.warning(GROK_GLYPHS.spinner)
			: this.state.result?.isError
				? tokens.error(GROK_GLYPHS.toolRowMarker)
				: this.state.result
					? tokens.success(GROK_GLYPHS.toolRowMarker)
					: tokens.warning(GROK_GLYPHS.toolRowMarker);
		return [`${tokens.mutedText(GROK_GLYPHS.toolRowGuide)} ${marker} ${tokens.primaryText(this.state.toolName)}`];
	}
}
