import { describe, expect, it, vi } from "vitest";

let readabilityParseCalls = 0;

vi.mock("@mozilla/readability", () => ({
	Readability: class {
		parse(): unknown {
			readabilityParseCalls += 1;
			return null;
		}
	},
}));

import { htmlToMarkdown } from "../../src/core/extensions/builtin/webfetch/webfetch/content.ts";

function explicitArticleHtml(): string {
	return `<!doctype html>
		<html>
			<body>
				<h1 class="tit_post">Explicit Article</h1>
				<div class="article_view">
					<p>Explicit article body has enough words to pass the direct article selector threshold.</p>
				</div>
			</body>
		</html>`;
}

describe("webfetch explicit article extraction", () => {
	it("#given an explicit article container #when converting markdown #then skips Readability fallback parsing", () => {
		// given / when
		const markdown = htmlToMarkdown(explicitArticleHtml(), "https://example.test/post");

		// then
		expect(markdown).toContain("# Explicit Article");
		expect(markdown).toContain("Explicit article body");
		expect(readabilityParseCalls).toBe(0);
	});
});
