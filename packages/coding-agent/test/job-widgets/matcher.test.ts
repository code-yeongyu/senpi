import { describe, expect, it } from "vitest";

import {
	compilePatterns,
	defaultLineMatcher,
	MatcherCompileError,
	patternGroupNames,
	scanPattern,
	validateJobWidgetSpec,
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
		// After a class opening with ] or a \Q…\E quote, the scanner is back outside.
		["[]a](?=b)", "lookaround"],
		[String.raw`\Qa\E(?=b)`, "lookaround"],
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
		"[](?=a)]",
		"[^](?=a)]",
		String.raw`\Q(?=a)\1(?P=n)(?R)\E`,
		"k<n> g{1} P=n",
		String.raw`(?P<ms>\d+\.\d+)ms`,
	];

	it.each(accepted)("accepts %s", (pattern) => {
		expect(scanPattern(pattern).error).toBeUndefined();
	});

	it("reads a class opening with ] as RE2 does: `]` and the text up to the next `]` are members", () => {
		for (const pattern of ["[](?=a)]", "[^](?=a)]"]) {
			expect(scanPattern(pattern)).toEqual({ groups: [], normalized: pattern });
		}
	});

	const quoted: [string, string[]][] = [
		[String.raw`\Q(?<x>a)\E(?<y>\d)`, ["y"]],
		[String.raw`(?P<a>\d)\Q(?P<b>\E(?<c>x)`, ["a", "c"]],
		[String.raw`(?<a>\d)\Q(?<b>x)`, ["a"]],
		[String.raw`\\Q(?<a>x)\\E`, ["a"]],
	];

	it.each(quoted)("skips \\Q\\E quoted text in %s, naming the groups RE2 names", (pattern, groups) => {
		expect(patternGroupNames(pattern)).toEqual(groups);
		expect(compilePatterns(defaultLineMatcher, [pattern]).groupNames).toEqual([groups]);
	});

	it("rejects a spec whose field names a group inside \\Q\\E", () => {
		const spec = (field: string) => ({
			title: "quoted",
			rules: [{ from: "out", match: String.raw`\Q(?<x>a)\E(?<y>\d)` }],
			blocks: [{ kind: "stat", items: [{ field, agg: "last", label: field }] }],
		});
		const checked = validateJobWidgetSpec(spec("x"), { matcher: defaultLineMatcher });
		expect(checked.ok).toBe(false);
		expect(checked.ok ? [] : checked.errors).toContainEqual(expect.stringContaining('unknown field "x"'));
		expect(validateJobWidgetSpec(spec("y"), { matcher: defaultLineMatcher }).ok).toBe(true);
	});

	it("has the RegExp fake refuse what JS reads differently: a class opening with ], and \\Q\\E", () => {
		for (const pattern of ["[](?=a)]", "x[^](?=a)]", String.raw`[]\d](?<n>\d)`, String.raw`\Q(?<x>a)\E`]) {
			const engine = new RegExpLineMatcher();
			expect(() => engine.compile(["ok", pattern])).toThrow(MatcherCompileError);
		}
		for (const pattern of [String.raw`\[](?<n>\d)`, "[a]]", "[[]", String.raw`[\Q]`, String.raw`\\Q`]) {
			expect(() => new RegExpLineMatcher().compile([pattern]), pattern).not.toThrow();
		}
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
