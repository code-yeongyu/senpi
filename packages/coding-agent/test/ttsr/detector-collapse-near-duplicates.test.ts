import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { collapseDetector, createCollapseState } from "../../src/core/extensions/builtin/ttsr/detectors/collapse.ts";
import {
	NEAR_DUPLICATE_ECHO_THRESHOLD,
	NEAR_DUPLICATE_WINDOW,
} from "../../src/core/extensions/builtin/ttsr/detectors/collapse-near-duplicates.ts";
import type { DetectorContext, DetectorMatch } from "../../src/core/extensions/builtin/ttsr/types.ts";
import { buildHealthyPrefix, HEALTHY_WORD_COUNT, healthyWord, lcg } from "./collapse-test-inputs.ts";

type Source = DetectorContext["source"];

interface Replay {
	readonly match: DetectorMatch | null;
	readonly firedAfterChars: number;
}

const context: DetectorContext = { source: "text", streamKey: "text:0", generation: 1 };

const INCIDENT = readFileSync(new URL("./fixtures/incident-near-duplicate-narration.txt", import.meta.url), "utf8");

function feedChunks(chunks: readonly string[], source: Source = "text"): Replay {
	const state = createCollapseState();
	let consumed = 0;
	for (const chunk of chunks) {
		const match = collapseDetector.checkDelta(state, chunk, { ...context, source });
		consumed += chunk.length;
		if (match !== null) return { match, firedAfterChars: consumed };
	}
	return { match: null, firedAfterChars: consumed };
}

function perChar(input: string, source: Source = "text"): Replay {
	return feedChunks(input.split(""), source);
}

function randomChunks(input: string, seed: number, source: Source = "text"): Replay {
	const next = lcg(seed);
	const chunks: string[] = [];
	for (let offset = 0; offset < input.length; ) {
		const size = 1 + (next() % 97);
		chunks.push(input.slice(offset, offset + size));
		offset += size;
	}
	return feedChunks(chunks, source);
}

function paraphraseOfOneAction(index: number): string {
	const openers = [
		"I'm assembling the final delivery now",
		"I'm putting together the final payload",
		"I'm compiling the delivery code",
		"I'm writing out the final assembly",
	];
	const tails = [
		"downloading the images, building both captions, linting them, and sending both batches",
		"fetching the images, assembling both captions, running the lint pass, and dispatching both batches",
		"pulling the images, composing both captions, checking the lint, and delivering both batches",
	];
	const opener = openers[index % openers.length] ?? "";
	const tail = tails[index % tails.length] ?? "";
	return `${opener}: ${tail} to the channel with attachments.`;
}

function distinctParagraph(index: number): string {
	const next = lcg(index * 7919 + 13);
	const pick = () => healthyWord(next() % HEALTHY_WORD_COUNT);
	return Array.from(
		{ length: 3 },
		() => `The ${pick()} beside the ${pick()} keeps ${pick()} within ${pick()} while ${pick()} waits on ${pick()}.`,
	).join(" ");
}

function joinParagraphs(parts: readonly string[]): string {
	return `${parts.join("\n\n")}\n\n`;
}

describe("near-duplicate paragraph frequency detector", () => {
	it("fires on the real paraphrased narration loop captured in the incident", () => {
		const { match, firedAfterChars } = perChar(INCIDENT);
		expect(match?.rule).toBe("collapse-repetition");
		expect(match?.detail.mechanism).toBe("near-duplicate-paragraphs");
		expect(firedAfterChars).toBeLessThan(8000);
		expect(match?.garbageStartOffset ?? 0).toBeGreaterThan(match?.anomalyStartOffset ?? 0);
	});

	it("reports the same match regardless of chunk boundaries", () => {
		const reference = perChar(INCIDENT).match;
		for (const seed of [7, 41, 1009]) {
			expect(randomChunks(INCIDENT, seed).match).toEqual(reference);
		}
	});

	it("fires on paraphrases that never repeat a paragraph byte-exactly", () => {
		const paragraphs = Array.from({ length: 24 }, (_, index) => paraphraseOfOneAction(index));
		const occurrences = new Map<string, number>();
		for (const paragraph of paragraphs) occurrences.set(paragraph, (occurrences.get(paragraph) ?? 0) + 1);
		expect(Math.max(...occurrences.values())).toBeLessThan(3);
		const { match } = perChar(joinParagraphs(paragraphs));
		expect(match?.detail.mechanism).toBe("near-duplicate-paragraphs");
		expect(match?.detail.window).toBeLessThanOrEqual(NEAR_DUPLICATE_WINDOW);
		expect(match?.detail.echoes).toBeGreaterThanOrEqual(NEAR_DUPLICATE_ECHO_THRESHOLD);
	});

	it("stays silent on distinct multi-sentence prose", () => {
		const paragraphs = Array.from({ length: 40 }, (_, index) => distinctParagraph(index));
		expect(perChar(joinParagraphs(paragraphs)).match).toBeNull();
	});

	it("stays silent when only a minority of the window echoes", () => {
		const paragraphs = Array.from({ length: 40 }, (_, index) =>
			index % 4 === 0
				? `${paraphraseOfOneAction(index)} Batch ${healthyWord(index * 31)} carried its own attachment set.`
				: distinctParagraph(index),
		);
		expect(new Set(paragraphs).size).toBe(paragraphs.length);
		expect(perChar(joinParagraphs(paragraphs)).match).toBeNull();
	});

	it("stays silent on a long healthy prose prefix", () => {
		expect(perChar(buildHealthyPrefix(64 * 1024)).match).toBeNull();
	});

	it("does not count paragraphs inside fenced code blocks", () => {
		const block = (index: number) =>
			[
				"```ts",
				`export function handler${index}(input: string): string {`,
				"\treturn input.trim();",
				"}",
				"```",
			].join("\n");
		const fenced = joinParagraphs(Array.from({ length: 24 }, (_, index) => block(index)));
		expect(perChar(fenced).match).toBeNull();
	});

	// senpi#2865: same-shaped code or markup outside a fence is not a narration loop.
	it("does not count unfenced repetitive SVG markup", () => {
		const svg = (index: number) =>
			[
				`<rect id="tile-${index}" x="${index * 37}" y="${(index * 53) % 400}" width="${20 + index}" height="${30 + index}" fill="#${(index * 1234567).toString(16).slice(0, 6)}" stroke="none"/>`,
				`<text x="${index * 37 + 4}" y="${((index * 53) % 400) + 18}" font-size="12">label ${index}</text>`,
			].join("\n");
		expect(perChar(joinParagraphs(Array.from({ length: 14 }, (_, index) => svg(index)))).match).toBeNull();
	});

	it("does not count unfenced repetitive JSON objects", () => {
		const json = (index: number) =>
			`{"id": ${index}, "name": "item-${index}", "price": ${(index * 3.7).toFixed(2)}, "tags": ["alpha", "beta"], "stock": ${index * 11}},`;
		expect(perChar(joinParagraphs(Array.from({ length: 14 }, (_, index) => json(index)))).match).toBeNull();
	});

	it("still catches a prose narration loop that has code lines between its paragraphs", () => {
		const parts = Array.from({ length: 24 }, (_, index) =>
			index % 2 === 0 ? paraphraseOfOneAction(index) : `  const batch${index} = await send(images[${index}]);`,
		);
		expect(perChar(joinParagraphs(parts)).match?.detail.mechanism).toBe("near-duplicate-paragraphs");
	});

	it("still scores a prose paragraph that carries one code-shaped line", () => {
		const parts = Array.from({ length: 24 }, (_, index) => `${paraphraseOfOneAction(index)}\n  sendBatch(${index});`);
		expect(perChar(joinParagraphs(parts)).match?.detail.mechanism).toBe("near-duplicate-paragraphs");
	});

	it("still catches a prose narration loop whose paragraphs end in a parenthesis", () => {
		const parts = Array.from({ length: 24 }, (_, index) => `${paraphraseOfOneAction(index)} (retrying)`);
		expect(perChar(joinParagraphs(parts)).match?.detail.mechanism).toBe("near-duplicate-paragraphs");
	});

	it("still catches a narration loop written as indented nested list items", () => {
		const parts = Array.from({ length: 24 }, (_, index) => `- step ${index}\n  - ${paraphraseOfOneAction(index)}`);
		expect(perChar(joinParagraphs(parts)).match?.detail.mechanism).toBe("near-duplicate-paragraphs");
	});

	it("does not watch tool argument streams", () => {
		expect(perChar(INCIDENT, "tool").match).toBeNull();
		expect(perChar(INCIDENT, "thinking").match?.detail.mechanism).toBe("near-duplicate-paragraphs");
	});

	it("leaves byte-identical cycles to the exact-repeat mechanism", () => {
		const paragraph =
			"Now I'm writing step one of the plan: defining the shared context block with rules and tool guidance for the lane.";
		const { match } = perChar(joinParagraphs([paragraph, paragraph, paragraph]));
		expect(match?.detail.mechanism).toBe("paragraph-repeat");
	});
});
