import { beforeAll, describe, expect, it } from "vitest";
import {
	LONG_LINE_FAST_PATH_LIMIT,
	renderIntraLineDiffFastPath,
	renderIntraLineDiffWithDiffWords,
} from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("renderIntraLineDiff fast path", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("returns byte-identical output to diffWords for provable single-span replacements", () => {
		const longPrefix = Array.from({ length: 90 }, (_, index) => `token${index}`).join(" ");
		const cases: ReadonlyArray<readonly [oldContent: string, newContent: string]> = [
			["const status = oldValue;", "const status = newValue;"],
			["  return format(oldValue);", "  return format(newValue);"],
			["alpha beta gamma", "alpha delta gamma"],
			["alphaBetaGamma", "alphaThetaGamma"],
			[`${longPrefix} before tail`, `${longPrefix} after tail`],
		];
		expect(longPrefix.length).toBeGreaterThan(LONG_LINE_FAST_PATH_LIMIT);

		for (const [oldContent, newContent] of cases) {
			const fastPath = renderIntraLineDiffFastPath(oldContent, newContent);

			expect(fastPath).toEqual(renderIntraLineDiffWithDiffWords(oldContent, newContent));
		}
	});

	it("falls back for whitespace-only and multi-span changes", () => {
		const cases: ReadonlyArray<readonly [oldContent: string, newContent: string]> = [
			["const x = 1;", "const  x = 1;"],
			["alpha beta gamma delta", "alpha theta gamma omega"],
			[" a-", " --"],
		];

		for (const [oldContent, newContent] of cases) {
			expect(renderIntraLineDiffFastPath(oldContent, newContent)).toBeNull();
		}
	});
});
