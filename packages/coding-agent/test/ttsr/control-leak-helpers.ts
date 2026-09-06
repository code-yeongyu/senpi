import { expect } from "vitest";

import {
	type ControlLeakState,
	createControlLeakDetector,
	type PendingControlEvidence,
} from "../../src/core/extensions/builtin/ttsr/detectors/control-leak.ts";
import type { DetectorContext, DetectorMatch } from "../../src/core/extensions/builtin/ttsr/types.ts";

const LESS_THAN = String.fromCharCode(60);
const GREATER_THAN = String.fromCharCode(62);
const PIPE = String.fromCharCode(124);
const LEFT_BRACKET = String.fromCharCode(91);
const RIGHT_BRACKET = String.fromCharCode(93);

export function ctrl(name: string): string {
	return [LESS_THAN, PIPE, name, PIPE, GREATER_THAN].join("");
}

export function sgml(name: string): string {
	return [LESS_THAN, name, GREATER_THAN].join("");
}

export function bracket(name: string): string {
	return [LEFT_BRACKET, name, RIGHT_BRACKET].join("");
}

export const CONTROL_LEAK_CTX: DetectorContext = {
	source: "thinking",
	streamKey: "fixture",
	generation: 1,
	toolProgressEpoch: 0,
};

export const PLAIN_PROSE_PREFIX =
	"We reviewed the failing render together and compared both panels side by side. " +
	"The drift came from a stale cache entry, so the fix invalidates on write rather than on read. " +
	"After the change the footer stayed stable across resizes.";

const REASONING_SENTENCE =
	"The migration path stayed compatible because every reader fell back to the legacy shape when the new field was missing. ";

export const LONG_REASONING_PREFIX = REASONING_SENTENCE.repeat(17);

export interface SplitResult {
	readonly label: string;
	readonly match: DetectorMatch | null;
	readonly flushMatch: DetectorMatch | null;
	readonly state: ControlLeakState;
}

function runDeltas(label: string, deltas: readonly string[]): SplitResult {
	const detector = createControlLeakDetector();
	const state = detector.createState();
	let match: DetectorMatch | null = null;
	for (const delta of deltas) {
		const found = detector.checkDelta(state, delta, CONTROL_LEAK_CTX);
		if (found !== null && match === null) {
			match = found;
		}
	}
	const flushMatch = detector.flush === undefined ? null : detector.flush(state, CONTROL_LEAK_CTX);
	return { label, match, flushMatch, state };
}

export function boundaryOffsets(fixture: string, tokens: readonly string[]): number[] {
	const offsets = new Set<number>();
	for (const token of tokens) {
		let index = fixture.indexOf(token);
		while (index >= 0) {
			offsets.add(index);
			offsets.add(index + token.length);
			index = fixture.indexOf(token, index + 1);
		}
	}
	return [...offsets].sort((a, b) => a - b);
}

export function runSplitMatrix(fixture: string, tokens: readonly string[]): SplitResult[] {
	const boundaries = boundaryOffsets(fixture, tokens);
	const runs: SplitResult[] = [runDeltas("whole", [fixture])];
	for (const boundary of boundaries) {
		runs.push(runDeltas(`split@${boundary}`, [fixture.slice(0, boundary), fixture.slice(boundary)]));
	}
	const points = [0, ...boundaries, fixture.length];
	const chunks: string[] = [];
	for (let i = 0; i + 1 < points.length; i += 1) {
		const start = points[i];
		const end = points[i + 1];
		if (start !== undefined && end !== undefined && end > start) {
			chunks.push(fixture.slice(start, end));
		}
	}
	runs.push(runDeltas("all-boundaries", chunks));
	const chars: string[] = [];
	for (let i = 0; i < fixture.length; i += 1) {
		chars.push(fixture.slice(i, i + 1));
	}
	runs.push(runDeltas("char-by-char", chars));
	return runs;
}

export interface ExpectedLeakMatch {
	readonly tokenId: string;
	readonly occurrences: number;
	readonly context: "start" | "normal" | "quotation";
	readonly anomalyStartOffset: number;
}

export function expectLeakMatchEverywhere(results: readonly SplitResult[], expected: ExpectedLeakMatch): void {
	for (const result of results) {
		expect(result.match, result.label).not.toBeNull();
		expect(result.match?.rule, result.label).toBe("control-token-leak");
		expect(result.match?.anomalyStartOffset, result.label).toBe(expected.anomalyStartOffset);
		expect(result.match?.garbageStartOffset, result.label).toBe(expected.anomalyStartOffset);
		expect(result.match?.detail, result.label).toMatchObject({
			tokenId: expected.tokenId,
			occurrences: expected.occurrences,
			context: expected.context,
		});
		expect(result.flushMatch, result.label).toBe(result.match);
	}
}

export function expectNoLeakMatchEverywhere(results: readonly SplitResult[]): void {
	for (const result of results) {
		expect(result.match, result.label).toBeNull();
		expect(result.flushMatch, result.label).toBeNull();
	}
}

export function requireEvidence(result: SplitResult): PendingControlEvidence {
	const evidence = result.state.pendingEvidence;
	if (evidence === undefined) {
		throw new Error(`pending evidence missing (${result.label})`);
	}
	return evidence;
}
