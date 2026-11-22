import { describe, expect, it } from "vitest";
import { findReservedKeywordRuns, findReservedKeywordSpans } from "../src/core/reserved-keywords.ts";

const keywordsOf = (text: string) => [...new Set(findReservedKeywordSpans(text).map((span) => span.keyword))];
const runsOf = (text: string) => findReservedKeywordRuns(text).map((run) => text.slice(run.start, run.end));

describe("reserved keyword matcher (engine parity)", () => {
	it("recognises every keyword and alias the engine arms on", () => {
		expect(keywordsOf("ulw fix the login bug")).toEqual(["ultrawork"]);
		expect(keywordsOf("please ULTRAWORK this")).toEqual(["ultrawork"]);
		for (const alias of ["mass ulw", "mass-ulw", "massulw", "ulw mass", "mulw", "meth"]) {
			expect(keywordsOf(`${alias} the migration`)).toContain("mass-ulw");
		}
		expect(keywordsOf("ulw plan the refactor")).toContain("ulw-plan");
		expect(keywordsOf("ulw-loop until green")).toContain("ulw-loop");
		expect(keywordsOf("ulwresearch the market")).toEqual(["ulw-research"]);
		expect(keywordsOf("mulw research the market")).toEqual(["ulw-research", "mass-ulw"]);
	});

	it("needs a whole word", () => {
		expect(keywordsOf("ulwfoo and ulw_helper and methane")).toEqual([]);
		expect(keywordsOf("ulw해줘")).toEqual(["ultrawork"]);
	});

	it("ignores keywords inside inline code, fenced code and injected blocks", () => {
		expect(keywordsOf("rename `ulw` to something else")).toEqual([]);
		expect(keywordsOf("```\nulw research\n```\nplain text")).toEqual([]);
		expect(keywordsOf("<ultrawork-mode>ulw</ultrawork-mode> plain")).toEqual([]);
		expect(runsOf("`ulw` then ulw loop")).toEqual(["ulw loop"]);
	});

	it("paints nothing the engine would not arm: identifiers, paths, URLs, quotes, relays and prohibitions", () => {
		for (const text of [
			"https://x.com/ulw-research",
			"open ./ulw/plan.md",
			"see .omo/ulw/state",
			"branch feat/tui-ulw-rainbow",
			"edit ulw-plan.md",
			"the mass-ulw-refactor branch",
			"the senpi-ulw-loop helper",
			"bump v1.ulw",
			'he said "ulw" twice',
			"> ulw quoted",
			"Do not load mass-ulw or ulw-research.",
			"[REPORT] ulw done",
		]) {
			expect(runsOf(text), text).toEqual([]);
		}
	});

	it("still paints the request around masked material", () => {
		expect(runsOf("read https://x.com/a then ulw the fix")).toEqual(["ulw"]);
		expect(runsOf("Do not use tmux, but ulw the fix")).toEqual(["ulw"]);
		expect(runsOf("mass ulw-loop the queue")).toEqual(["mass ulw-loop"]);
		expect(runsOf("Ulw-Research the market")).toEqual(["Ulw-Research"]);
	});

	it("returns overlapping spans over the original text", () => {
		const text = "go: mass ulw research";
		expect(findReservedKeywordSpans(text).map((span) => [span.keyword, text.slice(span.start, span.end)])).toEqual([
			["ulw-research", "mass ulw research"],
			["mass-ulw", "mass ulw"],
			["ultrawork", "ulw"],
		]);
		expect(findReservedKeywordSpans("nothing reserved here")).toEqual([]);
	});

	it("merges overlapping mentions into one painted run", () => {
		expect(runsOf("mass ulw research the docs, then ulw")).toEqual(["mass ulw research", "ulw"]);
		expect(runsOf("ulw fix the bug")).toEqual(["ulw"]);
		expect(runsOf("fix the bug")).toEqual([]);
	});
});
