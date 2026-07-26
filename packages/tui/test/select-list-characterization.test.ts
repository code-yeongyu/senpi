import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";

/**
 * BYTE-IDENTICAL CHARACTERIZATION GUARD for the select-list presentation seam.
 *
 * Every expected string below was captured by rendering SelectList with the
 * UNCHANGED pre-seam implementation (see .omo plan grok-neo todo G6). The
 * marker theme wraps each theme callback in distinctive tags:
 *
 *   <P> = selectedPrefix   <S> = selectedText   <D> = description
 *   <I> = scrollInfo       <N> = noMatch
 *
 * Because selectedPrefix is non-identity here, any change that starts applying
 * it in the default render path breaks this guard immediately. When the new
 * optional renderRow callback is absent, rendering MUST stay byte-identical to
 * these strings forever.
 */

const markerTheme = {
	selectedPrefix: (text: string) => `<P>${text}</P>`,
	selectedText: (text: string) => `<S>${text}</S>`,
	description: (text: string) => `<D>${text}</D>`,
	scrollInfo: (text: string) => `<I>${text}</I>`,
	noMatch: (text: string) => `<N>${text}</N>`,
};

const EXPECTED: Record<string, string[]> = {
	wideDescriptions: [
		"<S>→ help                            Show help</S>",
		"  quit<D>                            Exit the app</D>",
	],
	narrowWidth: ["<S>→ help</S>", "  quit"],
	noDescriptions: ["<S>→ alpha</S>", "  beta"],
	truncatedLongPrimary: [
		"<S>→ very-long-command-name-that-ne\u001b[0m  first</S>",
		"  short<D>                           second</D>",
	],
	cjkItems: [
		"  日本語コマンド<D>                  説明テキスト</D>",
		"<S>→ plain                           ascii desc</S>",
		"  日本語コマンドがとても長い場合\u001b[0m<D>  long cjk</D>",
	],
	scrollInfo: ["  four", "<S>→ five</S>", "  six", "<I>  (5/6)</I>"],
	noMatch: ["<N>  No matching commands</N>"],
	truncatedDescription: [
		"<S>→ help                            Show the help \u001b[0m</S>",
		"  quit<D>                            Exit the appli\u001b[0m</D>",
	],
};

describe("SelectList byte-identical characterization (pre-seam capture)", () => {
	it("renders selected and unselected rows with descriptions at wide width", () => {
		const list = new SelectList(
			[
				{ value: "help", label: "help", description: "Show help" },
				{ value: "quit", label: "quit", description: "Exit the app" },
			],
			5,
			markerTheme,
		);
		assert.deepStrictEqual(list.render(80), EXPECTED["wideDescriptions"]);
	});

	it("suppresses the description column at narrow width", () => {
		const list = new SelectList(
			[
				{ value: "help", label: "help", description: "Show help" },
				{ value: "quit", label: "quit", description: "Exit the app" },
			],
			5,
			markerTheme,
		);
		assert.deepStrictEqual(list.render(30), EXPECTED["narrowWidth"]);
	});

	it("renders rows without descriptions", () => {
		const list = new SelectList(
			[
				{ value: "alpha", label: "alpha" },
				{ value: "beta", label: "beta" },
			],
			5,
			markerTheme,
		);
		assert.deepStrictEqual(list.render(80), EXPECTED["noDescriptions"]);
	});

	it("truncates a long primary against the default column cap", () => {
		const list = new SelectList(
			[
				{
					value: "very-long-command-name-that-needs-truncation",
					label: "very-long-command-name-that-needs-truncation",
					description: "first",
				},
				{ value: "short", label: "short", description: "second" },
			],
			5,
			markerTheme,
		);
		assert.deepStrictEqual(list.render(80), EXPECTED["truncatedLongPrimary"]);
	});

	it("renders CJK wide-glyph primaries and descriptions", () => {
		const list = new SelectList(
			[
				{ value: "cjk", label: "日本語コマンド", description: "説明テキスト" },
				{ value: "plain", label: "plain", description: "ascii desc" },
				{ value: "cjklong", label: "日本語コマンドがとても長い場合のテスト", description: "long cjk" },
			],
			5,
			markerTheme,
		);
		list.setSelectedIndex(1);
		assert.deepStrictEqual(list.render(80), EXPECTED["cjkItems"]);
	});

	it("renders the scroll info line when items overflow maxVisible", () => {
		const list = new SelectList(
			[
				{ value: "one", label: "one" },
				{ value: "two", label: "two" },
				{ value: "three", label: "three" },
				{ value: "four", label: "four" },
				{ value: "five", label: "five" },
				{ value: "six", label: "six" },
			],
			3,
			markerTheme,
		);
		list.setSelectedIndex(4);
		assert.deepStrictEqual(list.render(80), EXPECTED["scrollInfo"]);
	});

	it("renders the no-match message when the filter removes every item", () => {
		const list = new SelectList([{ value: "help", label: "help" }], 5, markerTheme);
		list.setFilter("zzz");
		assert.deepStrictEqual(list.render(80), EXPECTED["noMatch"]);
	});

	it("truncates descriptions at mid width", () => {
		const list = new SelectList(
			[
				{ value: "help", label: "help", description: "Show the help text for everything" },
				{ value: "quit", label: "quit", description: "Exit the application immediately" },
			],
			5,
			markerTheme,
		);
		assert.deepStrictEqual(list.render(50), EXPECTED["truncatedDescription"]);
	});
});
