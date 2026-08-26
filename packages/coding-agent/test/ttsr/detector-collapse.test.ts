import { describe, expect, it } from "vitest";

import { collapseDetector, createCollapseState } from "../../src/core/extensions/builtin/ttsr/detectors/collapse.ts";
import type { DetectorContext, DetectorMatch } from "../../src/core/extensions/builtin/ttsr/types.ts";
import {
	AN11_LINE,
	AP1_PREFIX,
	AP9_LINE,
	AP10_LINE_A,
	AP10_LINE_B,
	AP12_PREFIX,
	buildAsciiArt,
	buildBase64,
	buildBoxTable,
	buildCjkArticle,
	buildHealthyPrefix,
	buildMarkdownRules,
	buildMinifiedJs,
	buildSeparatorComments,
	lcg,
} from "./collapse-test-inputs.ts";

interface CollapseExpectation {
	readonly mechanism: string;
	readonly anomalyStart: number;
	readonly garbageStart: number;
	readonly fireOffset: number;
	readonly period?: number;
}

interface CollapseRow {
	readonly id: string;
	readonly seed: number;
	readonly input: string;
	readonly expected: CollapseExpectation | null;
}

interface FeedOutcome {
	readonly match: DetectorMatch | null;
	readonly firstMatchOffset: number;
	readonly latchedStable: boolean;
}

const FEED_CONTEXT: DetectorContext = { source: "thinking", streamKey: "collapse-test", generation: 1 };
const TOOL_FEED_CONTEXT: DetectorContext = { source: "tool", streamKey: "tool:0", generation: 1 };

function feedChunks(chunks: readonly string[]): FeedOutcome {
	const state = createCollapseState();
	let match: DetectorMatch | null = null;
	let firstMatchOffset = -1;
	let latchedStable = true;
	let offset = 0;
	for (const chunk of chunks) {
		const result = collapseDetector.checkDelta(state, chunk, FEED_CONTEXT);
		if (result !== null) {
			if (match === null) {
				match = result;
				firstMatchOffset = offset;
			} else if (result !== match) {
				latchedStable = false;
			}
		}
		offset += chunk.length;
	}
	return { match, firstMatchOffset, latchedStable };
}

function feedPerChar(input: string): FeedOutcome {
	return feedChunks(input.split(""));
}

function feedRandomChunks(input: string, seed: number): FeedOutcome {
	const next = lcg(seed);
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < input.length) {
		const size = 1 + (next() % 97);
		chunks.push(input.slice(cursor, cursor + size));
		cursor += size;
	}
	return feedChunks(chunks);
}

const AP10_CYCLE_WIDTH = AP10_LINE_A.length + AP10_LINE_B.length + 2;
const AP9_LINE_WIDTH = AP9_LINE.length + 1;

const COLLAPSE_ROWS: readonly CollapseRow[] = [
	{
		id: "A-P1",
		seed: 11,
		input: AP1_PREFIX + "!".repeat(2207),
		expected: {
			mechanism: "dominant-scalar-run",
			anomalyStart: AP1_PREFIX.length,
			garbageStart: AP1_PREFIX.length + 1,
			fireOffset: AP1_PREFIX.length + 255,
		},
	},
	{
		id: "A-P2",
		seed: 12,
		input: "永".repeat(250),
		expected: { mechanism: "dominant-scalar-run", anomalyStart: 0, garbageStart: 1, fireOffset: 223 },
	},
	{
		id: "A-P3",
		seed: 13,
		input: "\u{1F600}".repeat(250),
		expected: { mechanism: "dominant-scalar-run", anomalyStart: 0, garbageStart: 2, fireOffset: 447 },
	},
	{
		id: "A-P4",
		seed: 14,
		input: "foo ".repeat(100),
		expected: { mechanism: "short-period", period: 4, anomalyStart: 0, garbageStart: 4, fireOffset: 259 },
	},
	{
		id: "A-P5",
		seed: 15,
		input: "yes no ".repeat(80),
		expected: { mechanism: "short-period", period: 7, anomalyStart: 0, garbageStart: 7, fireOffset: 262 },
	},
	{
		id: "A-P6",
		seed: 16,
		input: "!?".repeat(200),
		expected: { mechanism: "short-period", period: 2, anomalyStart: 0, garbageStart: 2, fireOffset: 257 },
	},
	{
		id: "A-P7",
		seed: 17,
		input: " ".repeat(600),
		expected: { mechanism: "whitespace-flood", anomalyStart: 0, garbageStart: 1, fireOffset: 479 },
	},
	{
		id: "A-P8",
		seed: 18,
		input: "\n".repeat(400),
		expected: { mechanism: "whitespace-flood", anomalyStart: 0, garbageStart: 1, fireOffset: 319 },
	},
	{
		id: "A-P9",
		seed: 19,
		input: `${AP9_LINE}\n`.repeat(6),
		expected: {
			mechanism: "line-cycle",
			period: 1,
			anomalyStart: 0,
			garbageStart: AP9_LINE_WIDTH,
			fireOffset: 6 * AP9_LINE_WIDTH - 1,
		},
	},
	{
		id: "A-P10",
		seed: 20,
		input: `${AP10_LINE_A}\n${AP10_LINE_B}\n`.repeat(6),
		expected: {
			mechanism: "line-cycle",
			period: 2,
			anomalyStart: 0,
			garbageStart: AP10_CYCLE_WIDTH,
			fireOffset: 6 * AP10_CYCLE_WIDTH - 1,
		},
	},
	{
		id: "A-P11",
		seed: 21,
		input: "ok\n".repeat(120),
		expected: { mechanism: "short-period", period: 3, anomalyStart: 0, garbageStart: 3, fireOffset: 258 },
	},
	{
		id: "A-P12",
		seed: 22,
		input: AP12_PREFIX + "!".repeat(500),
		expected: {
			mechanism: "dominant-scalar-run",
			anomalyStart: AP12_PREFIX.length,
			garbageStart: AP12_PREFIX.length + 1,
			fireOffset: AP12_PREFIX.length + 255,
		},
	},
	{ id: "A-N1", seed: 23, input: buildMarkdownRules(), expected: null },
	{ id: "A-N2", seed: 24, input: `// ${"=".repeat(2000)}\n// section end\n`, expected: null },
	{ id: "A-N3", seed: 25, input: buildAsciiArt(), expected: null },
	{ id: "A-N4", seed: 26, input: buildBoxTable(), expected: null },
	{ id: "A-N5", seed: 27, input: buildBase64(20480, 5), expected: null },
	{ id: "A-N6", seed: 28, input: "A".repeat(5000), expected: null },
	{ id: "A-N7", seed: 29, input: buildMinifiedJs(20480), expected: null },
	{ id: "A-N8", seed: 30, input: buildSeparatorComments(), expected: null },
	{ id: "A-N9", seed: 31, input: buildCjkArticle(20480, 9), expected: null },
	{ id: "A-N10", seed: 32, input: "00 ".repeat(500), expected: null },
	{ id: "A-N11", seed: 33, input: `${AN11_LINE}\n`.repeat(5), expected: null },
	{ id: "A-N12", seed: 34, input: " ".repeat(400), expected: null },
	{ id: "B-1", seed: 35, input: "!".repeat(255), expected: null },
	{
		id: "B-2",
		seed: 36,
		input: "!".repeat(256),
		expected: { mechanism: "dominant-scalar-run", anomalyStart: 0, garbageStart: 1, fireOffset: 255 },
	},
	{ id: "B-3", seed: 37, input: "永".repeat(223), expected: null },
	{
		id: "B-4",
		seed: 38,
		input: "永".repeat(224),
		expected: { mechanism: "dominant-scalar-run", anomalyStart: 0, garbageStart: 1, fireOffset: 223 },
	},
	{ id: "B-5", seed: 39, input: " ".repeat(479), expected: null },
	{
		id: "B-6",
		seed: 40,
		input: " ".repeat(480),
		expected: { mechanism: "whitespace-flood", anomalyStart: 0, garbageStart: 1, fireOffset: 479 },
	},
	{ id: "B-7", seed: 41, input: "\n".repeat(319), expected: null },
	{
		id: "B-8",
		seed: 42,
		input: "\n".repeat(320),
		expected: { mechanism: "whitespace-flood", anomalyStart: 0, garbageStart: 1, fireOffset: 319 },
	},
	{ id: "B-9", seed: 43, input: "foo ".repeat(64), expected: null },
	{
		id: "B-10",
		seed: 44,
		input: "foo ".repeat(65),
		expected: { mechanism: "short-period", period: 4, anomalyStart: 0, garbageStart: 4, fireOffset: 259 },
	},
	{
		id: "B-11",
		seed: 45,
		input: `${"!".repeat(80)}\n`.repeat(8),
		expected: { mechanism: "dominant-scalar-run", anomalyStart: 0, garbageStart: 1, fireOffset: 258 },
	},
	{ id: "H-1", seed: 46, input: buildHealthyPrefix(3072), expected: null },
];

function assertRow(row: CollapseRow, outcome: FeedOutcome, mode: string): void {
	const expected = row.expected;
	if (expected === null) {
		expect(outcome.match, `${row.id} (${mode}) must not match`).toBeNull();
		return;
	}
	if (outcome.match === null) {
		expect.unreachable(`${row.id} (${mode}): expected a match, got null`);
		return;
	}
	const match = outcome.match;
	expect(match.rule, `${row.id} (${mode}) rule`).toBe("collapse-repetition");
	expect(match.detail.mechanism, `${row.id} (${mode}) mechanism`).toBe(expected.mechanism);
	expect(match.anomalyStartOffset, `${row.id} (${mode}) anomalyStartOffset`).toBe(expected.anomalyStart);
	expect(match.garbageStartOffset, `${row.id} (${mode}) garbageStartOffset`).toBe(expected.garbageStart);
	expect(match.garbageStartOffset, `${row.id} (${mode}) keeps one unit`).toBeGreaterThan(match.anomalyStartOffset);
	expect(match.reason.length, `${row.id} (${mode}) reason`).toBeGreaterThan(0);
	if (expected.period !== undefined) {
		expect(match.detail.period, `${row.id} (${mode}) period`).toBe(expected.period);
	}
	expect(outcome.latchedStable, `${row.id} (${mode}) latch stability`).toBe(true);
	if (mode === "one-char deltas") {
		expect(outcome.firstMatchOffset, `${row.id} fire offset`).toBe(expected.fireOffset);
	}
}

const MODES = [
	{ name: "single delta", feed: (row: CollapseRow): FeedOutcome => feedChunks([row.input]) },
	{ name: "one-char deltas", feed: (row: CollapseRow): FeedOutcome => feedPerChar(row.input) },
	{
		name: "random deterministic chunks",
		feed: (row: CollapseRow): FeedOutcome => feedRandomChunks(row.input, row.seed),
	},
] as const;

describe("Detector A collapse/repetition spec rows", () => {
	for (const row of COLLAPSE_ROWS) {
		describe(row.id, () => {
			for (const mode of MODES) {
				it(mode.name, () => assertRow(row, mode.feed(row), mode.name));
			}
		});
	}
});

describe("collapse detector behavior", () => {
	it.each([
		["base64 blob", buildBase64(20480, 5)],
		["numeric table", Array.from({ length: 800 }, (_, index) => `${index},${index + 1},${index + 2}`).join("\n")],
		["code punctuation", buildMinifiedJs(20480)],
		["box drawing", buildBoxTable()],
	])("does not detect legitimate repetitive tool arguments: %s", (_name, input) => {
		const state = createCollapseState();
		expect(collapseDetector.checkDelta(state, input, TOOL_FEED_CONTEXT)).toBeNull();
	});
	it("latches the first match and returns it for every later delta", () => {
		const state = createCollapseState();
		const chunks = ["!".repeat(100), "!".repeat(100), "!".repeat(200), "and later text"];
		let first: DetectorMatch | null = null;
		for (const chunk of chunks) {
			const result = collapseDetector.checkDelta(state, chunk, FEED_CONTEXT);
			if (result === null) continue;
			if (first === null) {
				first = result;
			} else {
				expect(result).toBe(first);
			}
		}
		expect(first).not.toBeNull();
	});

	it("keeps per-generation state independent", () => {
		const armed = createCollapseState();
		const fresh = createCollapseState();
		expect(collapseDetector.checkDelta(armed, "!".repeat(300), FEED_CONTEXT)).not.toBeNull();
		expect(collapseDetector.checkDelta(fresh, "!".repeat(10), FEED_CONTEXT)).toBeNull();
	});

	it("joins pictographic scalars split mid-pair across deltas", () => {
		const emoji = "\u{1F600}";
		const chunks: string[] = [];
		for (let i = 0; i < 250; i++) {
			chunks.push(emoji.slice(0, 1), emoji.slice(1));
		}
		const outcome = feedChunks(chunks);
		if (outcome.match === null) {
			expect.unreachable("expected the pictographic run to match");
			return;
		}
		expect(outcome.match.anomalyStartOffset).toBe(0);
		expect(outcome.match.garbageStartOffset).toBe(2);
		expect(outcome.match.detail.mechanism).toBe("dominant-scalar-run");
	});
});
