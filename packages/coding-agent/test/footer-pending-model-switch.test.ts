import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

const WIDE = 180;
const NARROW = 90;

function render(width: number, options: Parameters<typeof createFooterSession>[0], providerCount = 1): string {
	const footer = new FooterComponent(createFooterSession(options), createFooterData(providerCount));
	const lines = footer.render(width);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return lines[0] ?? "";
}

// senpi#6092: a switch the session holds until the next message compacts for it
// (senpi#1873) was invisible in the footer, which kept naming the model still
// running. The right label now carries the held target beside the running model.
describe("footer names a held model switch (senpi#6092)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("shows the running model, the held target and the pending marker on a wide terminal", () => {
		const plain = stripAnsi(
			render(WIDE, {
				sessionName: "",
				modelId: "claude-opus-5-5",
				provider: "anthropic",
				reasoning: true,
				thinkingLevel: "medium",
				pendingModelSwitch: { id: "deepseek/deepseek-v4.1-flash-ultrafast", provider: "deepseek" },
			}),
		);
		expect(plain).toContain(
			"claude-opus-5-5 → deepseek/deepseek-v4.1-flash-ultrafast (after compact) • effort medium (shift+tab)",
		);
	});

	it("keeps the held target in the compact floor form on a narrow terminal", () => {
		const plain = stripAnsi(
			render(NARROW, {
				sessionName: "a-session-name-that-costs-width",
				modelId: "claude-opus-5-5",
				provider: "anthropic",
				reasoning: true,
				thinkingLevel: "medium",
				pendingModelSwitch: { id: "deepseek/deepseek-v4.1-flash-ultrafast", provider: "deepseek" },
			}),
		);
		expect(plain).toContain("claude-opus-5-5:medium → deepseek/deepseek-v4.1-flash-ultrafast (after compact)");
		expect(plain).not.toContain("effort medium");
	});

	it("colours the held target as pending, apart from the running model's accent", () => {
		const line = render(WIDE, {
			sessionName: "",
			modelId: "claude-opus-5-5",
			provider: "anthropic",
			reasoning: false,
			pendingModelSwitch: { id: "deepseek/deepseek-v4.1-flash-ultrafast", provider: "deepseek" },
		});
		expect(line).toContain(theme.fg("accent", "claude-opus-5-5"));
		expect(line).toContain(theme.fg("warning", "deepseek/deepseek-v4.1-flash-ultrafast"));
		expect(line).toContain(theme.fg("muted", " (after compact)"));
	});

	it("renders the label it always did when no switch is held", () => {
		const plain = stripAnsi(
			render(WIDE, {
				sessionName: "",
				modelId: "claude-opus-5-5",
				provider: "anthropic",
				reasoning: true,
				thinkingLevel: "medium",
			}),
		);
		expect(plain).toMatch(/claude-opus-5-5 • effort medium \(shift\+tab\)$/);
		expect(plain).not.toContain("→");
		expect(plain).not.toContain("after compact");
	});
});
