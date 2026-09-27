import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Marked, type TokenizerThis, type TokensList } from "marked";
import { clearRenderCache, Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

describe("Markdown math start boundaries", () => {
	it("bounds hint lookahead to the current line even with math at the end of a giant paragraph", (t) => {
		const lexer = Marked.prototype.lexer;
		let lookedAhead = 0;
		t.mock.method(Marked.prototype, "lexer", function (this: Marked, source: string, options = this.defaults) {
			const extensions = options.extensions;
			assert.ok(extensions);
			return lexer.call(this, source, {
				...options,
				extensions: {
					...extensions,
					startInline: extensions.startInline?.map(
						(start) =>
							function (this: TokenizerThis, remaining: string) {
								const boundary = start.call(this, remaining);
								const distance = boundary === undefined ? remaining.length : boundary + 1;
								const newline = remaining.indexOf("\n");
								assert.ok(newline < 0 || distance <= newline + 2, "hint must stop after the first newline");
								lookedAhead += distance;
								return boundary;
							},
					),
				},
			});
		});
		for (const count of [128, 256, 512, 1024]) {
			clearRenderCache();
			lookedAhead = 0;
			const rows = Array.from({ length: count }, (_, index) => `ROW_${index} ${"0123456789abcdef".repeat(8)}`);
			const source = `${rows.join("\n")}\nvalid $x^2$`;
			const lines = new Markdown(source, 0, 0, defaultMarkdownTheme).render(160);
			assert.deepEqual(
				lines.slice(0, count).map((line) => line.trimEnd()),
				rows,
			);
			assert.ok(lines[count]?.includes("x²"));
			assert.ok(lookedAhead > 0 && lookedAhead <= source.length * 4, "hint work must scale with source size");
		}
	});

	it("preserves canonical tokens and rendering across multiline Markdown and math boundaries", (t) => {
		const lexer = Marked.prototype.lexer;
		let originalHint = false;
		let lastTokens: TokensList | undefined;
		t.mock.method(Marked.prototype, "lexer", function (this: Marked, source: string, options = this.defaults) {
			const tokens = lexer.call(
				this,
				source,
				originalHint && options.extensions
					? {
							...options,
							extensions: {
								...options.extensions,
								startInline: [
									(remaining) => {
										const index = remaining.search(/\$|\\[()[\]]/);
										return index < 0 ? undefined : index;
									},
								],
							},
						}
					: options,
			);
			lastTokens = structuredClone(tokens);
			return tokens;
		});
		const cases = [
			"before  \nafter",
			"before\\\nafter",
			"before\nafter",
			"before  \r\nafter",
			"before\\\r\nafter",
			"trailing  \n",
			"trailing\\\n",
			"before **bold\nacross lines** after",
			"before _emphasis\nacross lines_ after",
			"before ~~strike\nacross lines~~ after",
			"`code\nspan` after",
			"``code `\n span`` after",
			"[link\nlabel](https://example.invalid)",
			"[late\nlabel][ref]\n\n[ref]: https://example.invalid",
			'[link](https://example.invalid "title\ncontinues")',
			'<a\nhref="https://example.invalid">raw\ntext</a>',
			"before $x^2$\nafter",
			"before\n$x^2$ after",
			"before $x\n+y$ after",
			String.raw`before \(x^2\) and \[y_1\]`,
			"$$\nx^2\n$$",
			"\\[\nx^2\n\\]",
			"> quote **bold\n> across**  \n> hard break\n>\n> - item\n>   continued $x^2$",
			"- item  \n  hard break\n- next\n  continuation",
			"| A | B |\n| - | - |\n| $x^2$ | **bold** |",
			"```ts\nconst n = 1;\n``",
			"`unclosed\n$x^2$",
			"currency $5\nand $10",
			"~~strict~~ and ~literal~",
			"malformed \\(x\n+y\\)",
			"malformed \\[x\n+y\\]",
			"word_\n_emphasis",
			"word\n_emphasis_",
			String.raw`C:\temp\file and escaped \*stars\*`,
			"entity &#36;\ntext",
			"plain\n\\) literal closer",
		];
		const fragments = [
			"plain",
			"trailing  ",
			"trailing\\",
			"*open",
			"close*",
			"_open",
			"close_",
			"`open",
			"close`",
			"$x^2$",
			"[open",
			"close](url)",
		];
		for (const left of fragments) for (const right of fragments) cases.push(`${left}\n${right}`);
		for (const source of cases) {
			originalHint = true;
			clearRenderCache();
			const expected = new Markdown(source, 0, 0, defaultMarkdownTheme).render(60);
			const expectedTokens = lastTokens;
			originalHint = false;
			clearRenderCache();
			const actual = new Markdown(source, 0, 0, defaultMarkdownTheme).render(60);
			assert.deepEqual(lastTokens, expectedTokens, source);
			assert.deepEqual(actual, expected, source);
		}
	});
});
