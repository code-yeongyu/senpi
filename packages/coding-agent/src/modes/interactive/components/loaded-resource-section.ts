import { Container, Spacer } from "@earendil-works/pi-tui";
import { ThemedText } from "./themed-text.ts";

/**
 * One startup banner section (`[Skills]`, `[Extensions]`, ...) with a collapsed and an expanded body.
 * A section whose collapsed body is empty renders nothing until it is expanded, so a banner that
 * would only list system resources disappears from the compact view without leaving a blank gap.
 * The bodies are built on demand, so the section follows theme changes like other themed text.
 */
export class LoadedResourceSection extends Container {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;
	private readonly body: ThemedText;
	private expanded = false;

	constructor(getCollapsedText: () => string, getExpandedText: () => string, expanded: boolean) {
		super();
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
		this.body = new ThemedText(() => (this.expanded ? this.getExpandedText() : this.getCollapsedText()), 0, 0);
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.clear();
		// Emptiness does not depend on colors, so it is decided once per expansion change.
		const text = expanded ? this.getExpandedText() : this.getCollapsedText();
		if (text.length === 0) return;
		this.body.invalidate();
		this.addChild(this.body);
		this.addChild(new Spacer(1));
	}
}
