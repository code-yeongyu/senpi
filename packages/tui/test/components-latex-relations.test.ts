import assert from "node:assert";
import { describe, it } from "node:test";
import { latexToUnicode } from "../src/components/latex.ts";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("components/latex relational algebra symbols", () => {
	it("converts every relational algebra join command to its Unicode operator", () => {
		// Given / When / Then - one case per ported command (upstream f0592205f, living fork path).
		assert.strictEqual(latexToUnicode(String.raw`R \bowtie S`), "R ⋈ S");
		assert.strictEqual(latexToUnicode(String.raw`R \Join S`), "R ⋈ S");
		assert.strictEqual(latexToUnicode(String.raw`R \ltimes S`), "R ⋉ S");
		assert.strictEqual(latexToUnicode(String.raw`R \rtimes S`), "R ⋊ S");
		assert.strictEqual(latexToUnicode(String.raw`R \leftouterjoin S`), "R ⟕ S");
		assert.strictEqual(latexToUnicode(String.raw`R \rightouterjoin S`), "R ⟖ S");
		assert.strictEqual(latexToUnicode(String.raw`R \fullouterjoin S`), "R ⟗ S");
	});

	it("converts join commands inside grouped expressions", () => {
		// Given / When / Then
		assert.strictEqual(latexToUnicode(String.raw`(R \ltimes S) \bowtie T`), "(R ⋉ S) ⋈ T");
		assert.strictEqual(latexToUnicode(String.raw`\{R \fullouterjoin S\}`), "{R ⟗ S}");
	});

	it("leaves longer commands that merely share a join prefix literal", () => {
		// Given / When / Then - command scanning is greedy, so `\bowtieX` must not resolve to `\bowtie`.
		assert.strictEqual(latexToUnicode(String.raw`\bowtieX`), String.raw`\bowtieX`);
		assert.strictEqual(latexToUnicode(String.raw`\ltimesfoo`), String.raw`\ltimesfoo`);
	});

	it("renders join operators through the Markdown consumer", () => {
		// Given
		const markdown = new Markdown(String.raw`$R \bowtie S \ltimes T$`, 0, 0, defaultMarkdownTheme);

		// When
		const rendered = stripAnsi(markdown.render(40)[0] ?? "").trimEnd();

		// Then
		assert.strictEqual(rendered, "R ⋈ S ⋉ T");
	});
});
