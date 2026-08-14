import { describe, expect, it, vi } from "vitest";
import { BtwPanel } from "../../src/core/extensions/builtin/btw/panel.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { testTheme } from "./history-search-fixtures.ts";

function fakeTui() {
	return {
		requestRender: vi.fn(),
	};
}

describe("btw live panel", () => {
	it("removes terminal controls from the question, streamed answer, and error detail", () => {
		const panel = new BtwPanel("question\x1b[2J\x07", fakeTui(), testTheme);
		panel.appendText("answer \x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\\x1b]52;c;AAAA\x07");
		panel.markError("failure\x1b[2J\x07");

		const rendered = panel.component.render(80).join("\n");

		expect(rendered).not.toContain("https://evil.test");
		expect(rendered).not.toContain("52;c;AAAA");
		expect(stripAnsi(rendered)).toContain("btw: question");
		expect(stripAnsi(rendered)).toContain("answer link");
		expect(stripAnsi(rendered)).toContain("error: failure");
	});
});
