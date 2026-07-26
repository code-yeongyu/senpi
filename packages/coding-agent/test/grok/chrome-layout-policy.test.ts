import { type Component, Container, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { DynamicBorder } from "../../src/modes/interactive/components/dynamic-border.ts";
import { GrokChrome } from "../../src/modes/interactive/grok/chrome.ts";
import { GrokInputCard } from "../../src/modes/interactive/grok/input-card.ts";
import { fg, GROK_COLOR_MODES, initGrokTheme, resetGrokThemeCapabilities } from "./theme-assertions.ts";

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function component(lines: string[]): Component {
	return { render: () => lines, invalidate: () => {} };
}

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`Grok chrome layout and overlay policy (${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});

		it("bottom-anchors the input card for a short transcript at the terminal height", () => {
			const tui = new TUI(new VirtualTerminal(20, 10));
			const chrome = new GrokChrome();
			const inputCard = new GrokInputCard(component(["draft"]));
			const root = chrome.arrangeRoot(
				[component(["transcript one", "transcript two"]), inputCard, component([]), component(["footer"])],
				tui,
			);
			for (const child of root) tui.addChild(child);

			const rendered = tui.render(20).map(stripAnsi);
			expect(rendered).toHaveLength(10);
			expect(rendered.slice(6)).toEqual([
				"╭──────────────────╮",
				"│draft             │",
				"╰──────────────────╯",
				"footer",
			]);
		});

		it("has no overlay-options decoration seam; default modal borders inherit the active border token", () => {
			const chrome = new GrokChrome();
			const overlay = new Container();
			overlay.addChild(new DynamicBorder());
			new TUI(new VirtualTerminal(20, 10)).showOverlay(overlay);

			expect(chrome).not.toHaveProperty("decorateOverlay");
			expect(overlay.render(20)).toEqual([fg("border", "─".repeat(20))]);
		});
	});
}
