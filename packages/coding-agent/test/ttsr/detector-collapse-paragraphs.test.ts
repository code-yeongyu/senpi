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

const context: DetectorContext = { source: "text", streamKey: "text:0", generation: 1 };

function narration(i: number): string {
	return `Now I'm writing step ${i} of the plan: defining the shared context block with rules and tool guidance, then each research lane with its own scoped prompt and report path. The implementation keeps every result precise and useful.`;
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
