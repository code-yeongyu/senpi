import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFooterData, createFooterSession } from "./helpers/footer-test-fixtures.ts";

const LIGHTNING = "\u26a1";

function renderFooter(footer: FooterComponent, width: number): string {
	return footer
		.render(width)
		.map((line) => stripAnsi(line))
		.join("\n");
}

describe("FooterComponent fast mode indicator", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("marks the model label with a lightning bolt while fast mode is active", () => {
		// given
		const session = createFooterSession({
			sessionName: "",
			modelId: "gpt-5.6-sol",
			provider: "openai-codex",
			reasoning: true,
			thinkingLevel: "medium",
			fastModeActive: true,
		});
		const footer = new FooterComponent(session, createFooterData(2));

		// when
		const rendered = renderFooter(footer, 120);

		// then
		expect(rendered).toContain(`${LIGHTNING} gpt-5.6-sol:medium`);
		expect(rendered).toContain(`(openai-codex) ${LIGHTNING} gpt-5.6-sol:medium`);
	});

	it("leaves the model label alone while fast mode is off", () => {
		// given
		const session = createFooterSession({
			sessionName: "",
			modelId: "gpt-5.6-sol",
			provider: "openai-codex",
			reasoning: true,
			thinkingLevel: "medium",
			fastModeActive: false,
		});
		const footer = new FooterComponent(session, createFooterData(2));

		// when
		const rendered = renderFooter(footer, 120);

		// then
		expect(rendered).toContain("gpt-5.6-sol:medium");
		expect(rendered).not.toContain(LIGHTNING);
	});

	it("keeps every line inside the terminal width when the indicator is shown", () => {
		// given
		// The indicator has to be part of the width math, not appended after truncation:
		// a wide CJK model id at a narrow width is where an appended glyph would overflow.
		const width = 60;
		const session = createFooterSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "openai-codex",
			reasoning: true,
			thinkingLevel: "medium",
			fastModeActive: true,
		});
		const footer = new FooterComponent(session, createFooterData(2));

		// when
		const lines = footer.render(width);

		// then
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
