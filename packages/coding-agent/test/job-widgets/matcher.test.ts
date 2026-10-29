import { describe, expect, it } from "vitest";

import {
	compilePatterns,
	MatcherCompileError,
	scanPattern,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { RegExpLineMatcher } from "./support.ts";

describe("line matcher port", () => {
	it("hands the engine one group spelling, leaving escapes and classes alone", () => {
		const engine = new RegExpLineMatcher();
		const patterns = [String.raw`a(?P<x>\d)`, String.raw`(?<y>\w+)`, String.raw`[(?P<]\(?P<z>`];
		const compiled = compilePatterns(engine, patterns);
		expect(engine.compiled).toEqual([[String.raw`a(?<x>\d)`, String.raw`(?<y>\w+)`, String.raw`[(?P<]\(?P<z>`]]);
		expect(compiled.groupNames).toEqual([["x"], ["y"], []]);
	});

	// Every spelling that needs a backtracking engine, each with the class its error names.
	const rejected: [string, string][] = [
		...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string, string] => [`(a)${"\\"}${n}`, "backreference"]),
		[String.raw`(?<n>a)\k<n>`, "backreference"],
		[String.raw`(?<n>a)\k'n'`, "backreference"],
		[String.raw`(?<n>a)\k{n}`, "backreference"],
		["(?P<n>a)(?P=n)", "backreference"],
		[String.raw`(a)\g{1}`, "backreference"],
		[String.raw`(?<n>a)\g{n}`, "backreference"],
		[String.raw`(a)\g1`, "backreference"],
		[String.raw`(a)\g-1`, "backreference"],
		[String.raw`(a)\g+1`, "backreference"],
		[String.raw`(?<n>a)\g<n>`, "recursion"],
		[String.raw`(a)\g<1>`, "recursion"],
		[String.raw`(?<n>a)\g'n'`, "recursion"],
		["(?P<n>a)(?P>n)", "recursion"],
		["a(?R)?b", "recursion"],
		["(a(?0)?b)", "recursion"],
		["(a(?1)?b)", "recursion"],
		["(a(?-1)?b)", "recursion"],
		["(a(?+1)b)", "recursion"],
		["(?<n>a)(?&n)", "recursion"],
		["(a)(?(1)b|c)", "conditional"],
		["a(?=b)", "lookaround"],
		["a(?!b)", "lookaround"],
		["(?<=a)b", "lookaround"],
		["(?<!a)b", "lookaround"],
		["a(?*b)", "lookaround"],
		["(?<*a)b", "lookaround"],
		["(*pla:a)b", "verb"],
		["a(*SKIP)b", "verb"],
		// Inside a named group in either spelling.
		[String.raw`(?P<n>a\k{n})`, "backreference"],
		["(?<n>a(?<=b)c)", "lookaround"],
		["(?P<n>a(?&n)?)", "recursion"],
	];

	it.each(rejected)("rejects %s (%s) before any engine sees it", (pattern, kind) => {
		expect(scanPattern(pattern).error).toContain(kind);
		const engine = new RegExpLineMatcher();
		expect(() => compilePatterns(engine, [pattern])).toThrow(MatcherCompileError);
		expect(engine.compiled).toEqual([]);
	});

	// Look-alikes that are legitimate: escaped backslashes, class members, group and flag syntax.
	const accepted: string[] = [
		String.raw`(?P<name>\d+)`,
		String.raw`(?<name>\d+)`,
		"(?:a|b)",
		"(?i)abc",
		"(?i:abc)",
		"(?-s:a.)",
		String.raw`\\k<n>`,
		String.raw`\\k'n'`,
		String.raw`\\k{n}`,
		String.raw`\\g{1}`,
		String.raw`\\g<n>`,
		String.raw`\\1`,
		String.raw`\k`,
		String.raw`\(?R\)`,
		String.raw`\(?1\)`,
		String.raw`\(*SKIP\)`,
		String.raw`\(?=`,
		"[(?=]+",
		"[(?P=n)(?R)(?1)(?&n)(*]",
		String.raw`[]\d](?<n>\d)`,
		"k<n> g{1} P=n",
		String.raw`(?P<ms>\d+\.\d+)ms`,
	];

	it.each(accepted)("accepts %s", (pattern) => {
		expect(scanPattern(pattern).error).toBeUndefined();
	});

	it("reports the rejected pattern's index", () => {
		const engine = new RegExpLineMatcher();
		let caught: unknown;
		try {
			compilePatterns(engine, ["ok", "(?<=x)y"]);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(MatcherCompileError);
		expect(caught).toMatchObject({ pattern: 1, reason: expect.stringContaining("lookaround") });
		// The engine never sees a batch holding a rejected pattern.
		expect(engine.compiled).toEqual([]);
	});
});
