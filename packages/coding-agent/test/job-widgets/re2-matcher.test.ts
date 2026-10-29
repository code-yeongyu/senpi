import { describe, expect, it } from "vitest";

import {
	compilePatterns,
	defaultLineMatcher,
	MatcherCompileError,
	Re2LineMatcher,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";

function compileError(patterns: readonly string[]): unknown {
	try {
		new Re2LineMatcher().compile(patterns);
	} catch (error) {
		return error;
	}
	return undefined;
}

/** Fastest of several runs, so a GC pause or a busy host cannot inflate one sample. */
function fastestMs(run: () => void, repeats = 7): number {
	let fastest = Number.POSITIVE_INFINITY;
	for (let attempt = 0; attempt < repeats; attempt++) {
		const started = performance.now();
		run();
		fastest = Math.min(fastest, performance.now() - started);
	}
	return fastest;
}

describe("re2 line matcher", () => {
	it("reports named-group spans in UTF-16 units, undefined for a group that took no part", () => {
		const compiled = defaultLineMatcher.compile([String.raw`(?P<word>[a-z]+) (?<num>\d+)|(?P<other>x)`, "zzz"]);
		expect(compiled.groupNames).toEqual([["word", "num", "other"], []]);
		expect(compiled.matchLines(["😀 ab 12", "none", "x zzz"])).toEqual([
			{ line: 0, pattern: 0, spans: [{ start: 3, end: 5 }, { start: 6, end: 8 }, undefined] },
			{ line: 2, pattern: 0, spans: [undefined, undefined, { start: 0, end: 1 }] },
			{ line: 2, pattern: 1, spans: [] },
		]);
	});

	const rejected: [string, string][] = [
		["lookbehind", "(?<=a)b"],
		["negative lookbehind", "(?<!a)b"],
		["lookahead", "a(?=b)"],
		["negative lookahead", "a(?!b)"],
		["numbered backreference", String.raw`(a)\1`],
		["named backreference", String.raw`(?<n>a)\k<n>`],
		["unbalanced group", String.raw`rps=(?P<rps>\d+`],
	];

	it.each(rejected)("rejects a %s at compile, naming the pattern", (_name, pattern) => {
		const error = compileError(["ok", pattern]);
		expect(error).toBeInstanceOf(MatcherCompileError);
		expect(error).toMatchObject({ pattern: 1, reason: expect.stringContaining("error parsing regexp") });
	});

	it("matches a catastrophic-backtracking pattern in time linear in the line", () => {
		const compiled = compilePatterns(defaultLineMatcher, ["^(a+)+$"]);
		const timeFor = (length: number) => {
			const line = `${"a".repeat(length)}b`;
			return fastestMs(() => expect(compiled.matchLines([line])).toEqual([]));
		};
		// Both sizes sit above re2js's BitState cutoff (about 26k chars for this pattern), so both run on
		// the same NFA/DFA engine and the ratio measures scaling, not an engine switch.
		timeFor(50_000);
		const short = timeFor(50_000);
		const long = timeFor(250_000);
		// 5x the input: linear is about 5x; quadratic would be 25x and backtracking never ends.
		expect(long / Math.max(short, 0.05)).toBeLessThan(10);
		expect(long).toBeLessThan(5_000);
	});
});
