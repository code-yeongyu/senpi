import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
	clearRenderCache,
	getMarkdownHighlightCallCount,
	Markdown,
	type MarkdownTheme,
	resetMarkdownHighlightCallCount,
} from "../src/index.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

function themeWithHighlight(): MarkdownTheme {
	return { ...defaultMarkdownTheme, highlightCode: (code: string) => code.split("\n") };
}

describe("markdown highlight cache and caps", () => {
	beforeEach(() => {
		clearRenderCache();
		resetMarkdownHighlightCallCount();
	});

	it("does not re-highlight unchanged code blocks when streamed markdown grows", () => {
		const theme = themeWithHighlight();
		const base = "```ts\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```";
		new Markdown(base, 1, 0, theme).render(80);
		const afterBase = getMarkdownHighlightCallCount();
		assert.equal(afterBase, 2);

		new Markdown(`${base}\n\n\`\`\`py\nx = 3\n\`\`\``, 1, 0, theme).render(80);

		assert.equal(getMarkdownHighlightCallCount() - afterBase, 1);
	});

	it("skips synchronous highlighting for oversized code blocks while rendering the text", () => {
		const theme = themeWithHighlight();
		const code = Array.from({ length: 2500 }, (_value, index) => `line ${index}`).join("\n");
		const lines = new Markdown(`\`\`\`ts\n${code}\n\`\`\``, 1, 0, theme).render(120);
		const output = lines.join("\n");

		assert.equal(getMarkdownHighlightCallCount(), 0);
		assert.match(output, /syntax highlighting skipped/);
		assert.match(output, /line 0/);
		assert.match(output, /line 2499/);
	});

	it("caps highlighting by UTF-8 byte length", () => {
		const theme = themeWithHighlight();
		const cjk = "中".repeat(70_000);
		assert.ok(cjk.length < 200_000);
		assert.ok(Buffer.byteLength(cjk, "utf8") > 200_000);

		const lines = new Markdown(`\`\`\`ts\n${cjk}\n\`\`\``, 1, 0, theme).render(120);

		assert.equal(getMarkdownHighlightCallCount(), 0);
		assert.match(lines.join("\n"), /syntax highlighting skipped/);
	});
});
