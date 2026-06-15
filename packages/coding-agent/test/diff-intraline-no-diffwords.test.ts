import type { Change } from "diff";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LONG_LINE_FAST_PATH_LIMIT,
	renderIntraLineDiff,
	renderIntraLineDiffFastPath,
} from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type DiffWords = (oldStr: string, newStr: string) => Change[];

const diffWordsMock = vi.hoisted(() =>
	vi.fn<DiffWords>(() => {
		throw new Error("diffWords should not be called");
	}),
);

vi.mock("diff", () => ({
	diffWords: diffWordsMock,
}));

describe("renderIntraLineDiff no-diffWords fast path", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		diffWordsMock.mockClear();
	});

	it("skips diffWords when the line content is identical", () => {
		const content = "const unchanged = formatValue(input);";

		const result = renderIntraLineDiff(content, content);

		expect(result).toEqual({ removedLine: content, addedLine: content });
		expect(diffWordsMock).not.toHaveBeenCalled();
	});

	it("skips diffWords when a very long line has one replacement span", () => {
		const prefix = Array.from({ length: 90 }, (_, index) => `token${index}`).join(" ");
		expect(prefix.length).toBeGreaterThan(LONG_LINE_FAST_PATH_LIMIT);
		const removed = `${prefix} before tail`;
		const added = `${prefix} after tail`;
		const fastPath = renderIntraLineDiffFastPath(removed, added);

		const result = renderIntraLineDiff(removed, added);

		expect(fastPath).not.toBeNull();
		expect(result).toEqual(fastPath);
		expect(diffWordsMock).not.toHaveBeenCalled();
	});
});
