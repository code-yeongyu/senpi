import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

const WIDE = 180;
const NARROW = 90;
const EIGHTY = 80;
const SIXTY = 60;
const LONG_TARGET = "deepseek/deepseek-v4.1-flash-ultrafast";
const ELIDED_TARGET = "…ash-ultrafast";

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

	it("keeps the full held target in the compact form while the left block still fits", () => {
		const plain = stripAnsi(
			render(140, {
				sessionName: "a-session-name-that-costs-width",
				modelId: "claude-opus-5-5",
				provider: "anthropic",
				reasoning: true,
				thinkingLevel: "medium",
				pendingModelSwitch: { id: LONG_TARGET, provider: "deepseek" },
			}),
		);
		expect(plain).toContain(`claude-opus-5-5:medium → ${LONG_TARGET} (after compact)`);
		expect(plain).toContain("(12.3%)");
		expect(plain).not.toContain("effort medium");
	});

	it.each([NARROW, EIGHTY])(
		"elides the held target and keeps the context meter at %i columns (senpi#6120)",
		(width) => {
			const plain = stripAnsi(
				render(width, {
					sessionName: "a-session-name-that-costs-width",
					modelId: "claude-opus-5-5",
					provider: "anthropic",
					reasoning: true,
					thinkingLevel: "medium",
					pendingModelSwitch: { id: LONG_TARGET, provider: "deepseek" },
				}),
			);
			expect(plain).toContain(`claude-opus-5-5:medium → ${ELIDED_TARGET} (after compact)`);
			expect(plain).toContain("(12.3%)");
			expect(plain).not.toContain("deepseek/");
		},
	);

	it("never shows a mid-id fragment of the held target at 60 columns (senpi#6120)", () => {
		const plain = stripAnsi(
			render(SIXTY, {
				sessionName: "",
				modelId: "claude-opus-5-5",
				provider: "anthropic",
				reasoning: true,
				thinkingLevel: "medium",
				pendingModelSwitch: { id: LONG_TARGET, provider: "deepseek" },
			}),
		);
		expect(plain).toMatch(/claude-opus-5-5:medium → …ash-ultrafast \(after compact\)$/);
		expect(plain).not.toContain("deepseek/");
	});

	it("keeps a short held target whole and adds no extra rung", () => {
		const plain = stripAnsi(
			render(EIGHTY, {
				sessionName: "",
				modelId: "claude-opus-5-5",
				provider: "anthropic",
				reasoning: true,
				thinkingLevel: "medium",
				pendingModelSwitch: { id: "mock-small", provider: "mock" },
			}),
		);
		expect(plain).toContain("claude-opus-5-5:medium → mock-small (after compact)");
		expect(plain).toContain("(12.3%)");
		expect(plain).not.toContain("…ock-small");
	});

	it("colours the held target as pending, apart from the running model's accent", () => {
		const line = render(WIDE, {
			sessionName: "",
			modelId: "claude-opus-5-5",
			provider: "anthropic",
			reasoning: false,
			pendingModelSwitch: { id: LONG_TARGET, provider: "deepseek" },
		});
		expect(line).toContain(theme.fg("accent", "claude-opus-5-5"));
		expect(line).toContain(theme.fg("warning", LONG_TARGET));
		expect(line).toContain(theme.fg("muted", " (after compact)"));
	});

	it("colours the elided held target the same way on the floor", () => {
		const line = render(EIGHTY, {
			sessionName: "",
			modelId: "claude-opus-5-5",
			provider: "anthropic",
			reasoning: false,
			pendingModelSwitch: { id: LONG_TARGET, provider: "deepseek" },
		});
		expect(line).toContain(theme.fg("warning", ELIDED_TARGET));
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
