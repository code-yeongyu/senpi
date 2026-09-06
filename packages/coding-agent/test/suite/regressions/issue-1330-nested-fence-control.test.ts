import { describe, expect, it } from "vitest";
import {
	createParagraphRepeatState,
	updateParagraphRepeats,
} from "../../../src/core/extensions/builtin/ttsr/detectors/collapse-paragraphs.ts";
import type { DetectorMatch } from "../../../src/core/extensions/builtin/ttsr/types.ts";

function paragraph(step: number): string {
	return `I am carefully describing the exact same implementation plan for this task, but now writing step ${step} with no substantive progress at all.`;
}

function detect(text: string): DetectorMatch[] {
	const state = createParagraphRepeatState();
	const matches: DetectorMatch[] = [];
	let offset = 0;
	for (const value of text) {
		const match = updateParagraphRepeats(state, { value, width: value.length, startOffset: offset });
		offset += value.length;
		if (match !== null) matches.push(match);
	}
	return matches;
}

describe("issue #1330: numeric prose inside code fences", () => {
	it("does not close a four-backtick fence with a shorter nested fence", () => {
		const text = [
			"````markdown",
			"```text",
			"",
			paragraph(3),
			"",
			paragraph(4),
			"",
			paragraph(5),
			"",
			"```",
			"````",
			"",
		].join("\n");

		expect(detect(text)).toEqual([]);
	});

	it("does not treat a fence with trailing text as a closing fence", () => {
		const text = [
			"```text",
			"```not-a-closing-fence",
			"",
			paragraph(3),
			"",
			paragraph(4),
			"",
			paragraph(5),
			"",
			"```",
			"",
		].join("\n");

		expect(detect(text)).toEqual([]);
	});

	it("detects a numeric loop after the actual closing fence", () => {
		const text = [
			"````markdown",
			"```text",
			"sample",
			"```",
			"````",
			"",
			paragraph(3),
			"",
			paragraph(4),
			"",
			paragraph(5),
			"",
			"",
		].join("\n");

		expect(detect(text)).toHaveLength(1);
	});
});
