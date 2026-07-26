import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getGrokChromeTokens } from "./chrome-tokens.ts";

/** Mode-owned startup welcome card for grok chrome. */
export class GrokWelcomeCard implements Component {
	private readonly appName: string;
	private readonly version: string;

	constructor(appName: string, version: string) {
		this.appName = appName;
		this.version = version;
	}

	invalidate(): void {
		// Render output is derived only from immutable constructor data and theme tokens.
	}

	render(width: number): string[] {
		const tokens = getGrokChromeTokens();
		if (width < 3) return [tokens.primaryText(truncateToWidth(`${this.appName} v${this.version}`, width, ""))];

		const contentWidth = width - 2;
		const line = (text: string) => {
			const truncated = truncateToWidth(text, contentWidth, "");
			return `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
		};
		const interior = (text: string) =>
			`${tokens.cardBorder("│")}${tokens.inputInterior(line(text))}${tokens.cardBorder("│")}`;

		return [
			tokens.cardBorder(`╭${"─".repeat(contentWidth)}╮`),
			interior(` ${tokens.primaryText(`${this.appName} v${this.version}`)}`),
			interior(" Ready for your next task."),
			tokens.cardBorder(`╰${"─".repeat(contentWidth)}╯`),
		];
	}
}
