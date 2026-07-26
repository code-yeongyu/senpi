import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getGrokChromeTokens } from "./chrome-tokens.ts";

/** Rounded grok input shell for the mode-owned base editor. */
export class GrokInputCard implements Component {
	private readonly editor: Component;

	constructor(editor: Component) {
		this.editor = editor;
	}

	invalidate(): void {
		this.editor.invalidate?.();
	}

	render(width: number): string[] {
		if (width < 3) return this.editor.render(width);

		const tokens = getGrokChromeTokens();
		const contentWidth = width - 2;
		const horizontal = "─".repeat(contentWidth);
		const editorLines = this.editor.render(contentWidth);
		const content = editorLines.length > 0 ? editorLines : [""];
		const paddedLines = content.map((line) => {
			const truncated = truncateToWidth(line, contentWidth, "");
			return `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
		});

		return [
			tokens.inputBorder(`╭${horizontal}╮`),
			...paddedLines.map(
				(line) => `${tokens.inputBorder("│")}${tokens.inputInterior(line)}${tokens.inputBorder("│")}`,
			),
			tokens.inputBorder(`╰${horizontal}╯`),
		];
	}
}
