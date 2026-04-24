import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML tool output whitespace", () => {
	it("preserves whitespace for plain-text tool output containers", () => {
		const css = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

		expect(css).toMatch(
			/\.tool-output > div,\s*\.output-preview,\s*\.output-full\s*\{[\s\S]*?white-space:\s*pre-wrap;/,
		);
	});
});
