import { describe, expect, it } from "vitest";

import { collapseDetector, createCollapseState } from "../../src/core/extensions/builtin/ttsr/detectors/collapse.ts";
import {
	createParagraphRepeatState,
	updateParagraphRepeats,
} from "../../src/core/extensions/builtin/ttsr/detectors/collapse-paragraphs.ts";
import { ScalarScanner } from "../../src/core/extensions/builtin/ttsr/stream-utils.ts";
import type { DetectorContext, DetectorMatch } from "../../src/core/extensions/builtin/ttsr/types.ts";
import { lcg } from "./collapse-test-inputs.ts";

type Source = DetectorContext["source"];

const context: DetectorContext = { source: "text", streamKey: "text:0", generation: 1, toolProgressEpoch: 0 };

function narration(i: number): string {
	return `Now I'm writing step ${i} of the plan: defining the shared context block with rules and tool guidance, then each research lane with its own scoped prompt and report path. The implementation keeps every result precise and useful.`;
}

function numericNarration(first: number, second: number): string {
	return `This status report records ${first} completed checks and ${second} pending checks while the implementation team preserves every scoped result, documents each concrete action, and keeps the recovery path precise for the next review.`;
}

function originalSingleDigitNarration(step: number): string {
	return `I am carefully describing the exact same implementation plan for this task, but now writing step ${step} with no substantive progress at all.`;
}

function loop(cycle: number, cycles: number, separator = "\n\n"): string {
	const block = Array.from({ length: cycle }, (_, i) => narration(i)).join(separator);
	return `${Array.from({ length: cycles }, () => block).join(separator)}${separator}`;
}

function feedChunks(chunks: readonly string[], source: Source = "text"): DetectorMatch | null {
	const state = createCollapseState();
	let match: DetectorMatch | null = null;
	for (const chunk of chunks) match ??= collapseDetector.checkDelta(state, chunk, { ...context, source });
	return match;
}

function perChar(input: string, source: Source = "text"): DetectorMatch | null {
	return feedChunks(input.split(""), source);
}

function random(input: string, seed: number, source: Source = "text"): DetectorMatch | null {
	const next = lcg(seed);
	const chunks: string[] = [];
	for (let offset = 0; offset < input.length; ) {
		const size = 1 + (next() % 97);
		chunks.push(input.slice(offset, offset + size));
		offset += size;
	}
	return feedChunks(chunks, source);
}

function direct(input: string): DetectorMatch | null {
	const state = createParagraphRepeatState();
	const scanner = new ScalarScanner();
	let match: DetectorMatch | null = null;
	for (const entry of scanner.push(input)) match ??= updateParagraphRepeats(state, entry);
	return match;
}

function numericLoop(values: readonly [number, number][]): string {
	return `${values.map(([first, second]) => numericNarration(first, second)).join("\n\n")}\n\n`;
}

function feedAtEpochs(segments: readonly { readonly text: string; readonly epoch: number }[]): DetectorMatch | null {
	const state = createCollapseState();
	let match: DetectorMatch | null = null;
	for (const segment of segments) {
		for (const char of segment.text) {
			match ??= collapseDetector.checkDelta(state, char, { ...context, toolProgressEpoch: segment.epoch });
		}
	}
	return match;
}

describe("paragraph repetition detector", () => {
	it("fires when the same 7-paragraph cycle streams three times", () => {
		const input = loop(7, 3);
		const match = perChar(input);
		const randomMatch = random(input, 41);
		expect(match?.rule).toBe("collapse-repetition");
		expect(match?.detail).toMatchObject({ mechanism: "paragraph-repeat", occurrences: 3 });
		expect(match?.anomalyStartOffset).toBe(0);
		expect(match?.garbageStartOffset).toBe(loop(7, 1).length);
		expect(randomMatch).toEqual(match);
	});

	it("stays silent after only two occurrences", () => expect(perChar(loop(7, 2))).toBeNull());

	it("detects the original single-digit no-progress loop", () => {
		const input = `${[3, 4, 5].map(originalSingleDigitNarration).join("\n\n")}\n\n`;
		const match = perChar(input);
		expect(match?.rule).toBe("collapse-repetition");
		expect(match?.detail).toMatchObject({ mechanism: "paragraph-repeat", normalized: true, occurrences: 3 });
		expect(match?.anomalyStartOffset).toBe(0);
		expect(match?.garbageStartOffset).toBe(`${originalSingleDigitNarration(3)}\n\n`.length);
	});

	it("keeps exact matching byte-exact while detecting three prose paragraphs with numeric drift", () => {
		const exact = `${numericNarration(101, 201)}\n\n`.repeat(3);
		const input = numericLoop([
			[101, 201],
			[102, 202],
			[103, 203],
		]);
		const expectedGarbageStart = `${numericNarration(101, 201)}\n\n`.length;
		const match = perChar(input);

		expect(direct(exact)?.detail).toMatchObject({ mechanism: "paragraph-repeat", occurrences: 3 });
		expect(direct(input)?.detail).toMatchObject({ normalized: true, occurrences: 3 });
		expect(match?.rule).toBe("collapse-repetition");
		expect(match?.anomalyStartOffset).toBe(0);
		expect(match?.garbageStartOffset).toBe(expectedGarbageStart);
		expect(random(input, 901)).toEqual(match);
	});

	it("does not normalize numeric drift across tool progress", () => {
		const paragraphs = [numericNarration(101, 201), numericNarration(102, 202), numericNarration(103, 203)];
		expect(feedAtEpochs(paragraphs.map((text, epoch) => ({ text: `${text}\n\n`, epoch })))).toBeNull();
	});

	it("keeps byte-exact repeats active across tool progress", () => {
		const paragraph = numericNarration(101, 201);
		const match = feedAtEpochs([0, 1, 2].map((epoch) => ({ text: `${paragraph}\n\n`, epoch })));
		expect(match?.detail).toMatchObject({ mechanism: "paragraph-repeat", occurrences: 3 });
		expect(match?.detail.normalized).toBeUndefined();
	});

	it("does not normalize changed prose, identifiers, code, math lists, punctuation, or whitespace", () => {
		const prose = numericNarration(101, 201);
		const changedProse = prose.replace("pending checks", "blocked checks");
		const identifiers = (id: number) =>
			`The worker${id} summary gives a detailed narrative with enough ordinary words to qualify as a paragraph while preserving the exact identifier for the next implementation review.`;
		const code = (value: number) =>
			`const retryLimit = ${value}; const summary = "The implementation keeps this code sample long enough to qualify as an eligible paragraph without treating its values as prose progress.";`;
		const structuredStep = (step: number) =>
			`I am recording step ${step} of the seven-step implementation plan with enough detailed prose to remain an eligible paragraph while preserving the meaningful planned sequence.`;
		const mathList = (value: number) =>
			`${value}. Preserve the first mathematical checkpoint with enough explanatory prose for eligibility.\n${value + 1}. Preserve the second mathematical checkpoint with enough explanatory prose for eligibility.`;
		const numericList = (value: number) =>
			`The mathematical checkpoint list contains ${value}, ${value + 100}, and ${value + 200} as meaningful values while the detailed explanation remains long enough to qualify as a paragraph.`;

		expect(perChar(`${prose}\n\n${prose}\n\n${changedProse}\n\n`)).toBeNull();
		expect(perChar(`${identifiers(3)}\n\n${identifiers(4)}\n\n${identifiers(5)}\n\n`)).toBeNull();
		expect(perChar(`${code(3)}\n\n${code(4)}\n\n${code(5)}\n\n`)).toBeNull();
		expect(perChar(`\`\`\`ts\n${code(3)}\n\n${code(4)}\n\n${code(5)}\n\`\`\`\n\n`)).toBeNull();
		expect(perChar(`${structuredStep(3)}\n\n${structuredStep(4)}\n\n${structuredStep(5)}\n\n`)).toBeNull();
		expect(perChar(`${mathList(3)}\n\n${mathList(4)}\n\n${mathList(5)}\n\n`)).toBeNull();
		expect(perChar(`${numericList(101)}\n\n${numericList(102)}\n\n${numericList(103)}\n\n`)).toBeNull();
		expect(perChar(`${prose}\n\n${prose.replace("checks and", "checks, and")}\n\n${prose}\n\n`)).toBeNull();
		expect(
			perChar(`${prose}\n\n${prose.replace("completed checks", "completed  checks")}\n\n${prose}\n\n`),
		).toBeNull();
	});

	it("ignores short paragraphs and punctuation-only paragraphs", () => {
		expect(direct("Done.\n\n".repeat(5))).toBeNull();
		expect(direct(`${"-".repeat(80)}\n\n`.repeat(4))).toBeNull();
	});

	it("compares paragraphs byte-exactly", () => {
		const variant = narration(0).replace("scoped prompt", "scoped brief");
		expect(direct(`${narration(0)}\n\n${narration(0)}\n\n${variant}\n\n`)).toBeNull();
		expect(direct(`${narration(0)}\n\n${narration(0)}\n\n${narration(0)}\n\n`)?.detail.occurrences).toBe(3);
	});

	it("treats whitespace-only lines as paragraph separators and hashes multi-line paragraphs", () => {
		const lines = [
			"Now the first detailed line explains the shared plan and its purpose.",
			"The second line carries enough prose to remain an eligible paragraph.",
			"Finally the third line records the scoped guidance for the lane.",
		];
		const input = `${Array.from({ length: 3 }, () => lines.join("\n")).join("\n   \n")}\n   \n`;
		expect(direct(input)?.detail.mechanism).toBe("paragraph-repeat");
		expect(direct(`${lines.join("\n")}\n\n${lines.join("\n")}\n\n${[...lines].reverse().join("\n")}\n\n`)).toBeNull();
	});

	it("does not watch tool argument streams", () => {
		const input = loop(7, 3);
		expect(perChar(input, "tool")).toBeNull();
		expect(perChar(input, "thinking")?.detail.mechanism).toBe("paragraph-repeat");
	});
});
