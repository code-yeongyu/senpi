import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as agent from "../../src/index.ts";
import { boundaryFixtures } from "./fixtures/read-summary/boundary-fixtures.ts";
import { functionReturningObjectType } from "./fixtures/read-summary/signature-fixtures.ts";

const body = (n: number) =>
	[`function f${n}() {`, ...Array.from({ length: 6 }, (_, i) => `  const x${i} = "brace } { [ ]";`), "}"].join("\n");
const siblings = Array.from({ length: 20 }, (_, i) => body(i)).join("\n");
function fold(text: string, path = "source.ts") {
	return agent.selectedReadFolder.fold({ path, text, settings: agent.READ_FOLD_SETTINGS });
}
function view(text: string, path = "source.ts") {
	return agent.createSegmentedReadView({ text, parsed: fold(text, path) });
}

describe("selected read folders (#1639)", () => {
	it("preserves function-return arrow object types in the public default view", () => {
		// Given twenty declarations whose return types have five-line object members.
		const text = functionReturningObjectType;
		// When reading by default; then every complete signature survives, or the whole file is raw.
		const rendered =
			agent.createDefaultReadSummary({
				path: "return-types.ts",
				text,
				folder: agent.selectedReadFolder,
				truncated: false,
			})?.text ?? text;
		const candidate = view(text);
		for (let index = 0; index < 20; index++) {
			const signature = text
				.split("\n")
				.slice(index * 9, index * 9 + 7)
				.join("\n");
			expect(rendered).toContain(signature);
			expect(candidate.status === "summary" ? candidate.rendered.text : text).toContain(signature);
		}
	});
	it("ambiguous syntax and unsupported languages fall back", () => {
		// Given malformed lexical constructs, unsupported indentation grammars and unsafe budgets.
		const cases = [
			{ name: "unterminated-comment", path: "x.ts", text: `${siblings}\n/* unfinished`, reason: "parse_failure" },
			{ name: "unterminated-string", path: "x.js", text: `${siblings}\n"unfinished`, reason: "parse_failure" },
			{
				name: "unterminated-template",
				path: "x.js",
				text: `${siblings}\nconst a = \`unfinished`,
				reason: "parse_failure",
			},
			{ name: "mismatched-delimiter", path: "x.ts", text: `${siblings}\nconst a = [);`, reason: "parse_failure" },
			{ name: "regex-ambiguity", path: "x.js", text: `${siblings}\n{} /[{}]/.test('a');`, reason: "parse_failure" },
			{ name: "regex-newline", path: "x.js", text: `${siblings}\nconst a = /[\n{}]/;`, reason: "parse_failure" },
			{
				name: "json-comment",
				path: "x.json",
				text: `${JSON.stringify(
					Array.from({ length: 120 }, () => 1),
					null,
					2,
				)}/*bad*/`,
				reason: "parse_failure",
			},
			{ name: "tsx", path: "x.tsx", text: siblings, reason: "unsupported_language" },
			{
				name: "python-indent",
				path: "x.py",
				text: "def example():\n\t x = 1\n    y = 2",
				reason: "unsupported_language",
			},
			{ name: "rust", path: "x.rs", text: siblings, reason: "unsupported_language" },
			{ name: "go", path: "x.go", text: siblings, reason: "unsupported_language" },
			{ name: "unknown", path: "x.jsx", text: siblings, reason: "unsupported_language" },
			{ name: "markdown", path: "x.md", text: siblings, reason: "prose_exempt" },
			{ name: "txt", path: "x.txt", text: siblings, reason: "prose_exempt" },
			{
				name: "oversized-skeleton",
				path: "x.ts",
				text: `${Array.from({ length: 101 }, (_, i) => `const x${i} = ${i};`).join("\n")}\n${body(1)}`,
				reason: "skeleton_exceeds_budget",
			},
			{
				name: "unreachable-budget",
				path: "x.ts",
				text: `function big() {\n${Array.from({ length: 110 }, (_, i) => `const x${i} = ${i};`).join("\n")}\n}`,
				reason: "visible_budget_unreachable",
			},
			{
				name: "no-folds",
				path: "x.ts",
				text: Array.from({ length: 100 }, () => "let x = 1;").join("\n"),
				reason: "no_elision",
			},
			{ name: "too-short", path: "x.ts", text: body(1), reason: "too_short" },
		];
		// When every case traverses the production registry and shared pure view.
		const results = cases.map((input) => ({
			name: input.name,
			expected: input.reason,
			result: view(input.text, input.path),
		}));
		const fresh = view(`${siblings}\n"unterminated`);
		// Then fallbacks are explicit and repeated path use never reuses a previous parse.
		for (const entry of results)
			expect(entry.result, entry.name).toEqual({ status: "no_summary", reason: entry.expected });
		expect(fresh).toEqual({ status: "no_summary", reason: "parse_failure" });
		const old = fold(siblings);
		const stale = agent.createSegmentedReadView({ text: `${siblings}\nchanged`, parsed: old });
		expect(stale).toEqual({
			status: "no_summary",
			reason: "stale_source",
		});
		const out = process.env.OMP_READ_VIEW_QA_DIR;
		if (out) {
			mkdirSync(out, { recursive: true });
			writeFileSync(
				join(out, "failure.json"),
				JSON.stringify({ cases: results, fresh, stale, passed: true }, null, 2),
			);
		}
	});

	it.each([99, 100])("applies the exact minimum-total boundary at %i lines", (total) => {
		// Given 96 body lines plus retained declarations reaching the boundary.
		const text = [
			Array.from({ length: 12 }, (_, i) => body(i)).join("\n"),
			...Array.from({ length: total - 96 }, (_, i) => `const top${i} = ${i};`),
		].join("\n");
		// When folding; then 99 is raw and 100 can summarize without altering thresholds.
		expect(text.split("\n")).toHaveLength(total);
		expect(view(text).status).toBe(total === 99 ? "no_summary" : "summary");
	});

	it("freezes the measured registry and exact D4 constants", () => {
		// Given the row-17 selection; when inspecting the production contract; then only selected engines exist.
		expect(agent.READ_FOLD_SETTINGS).toEqual({
			minBodyLines: 4,
			minCommentLines: 6,
			minTotalLines: 100,
			unfoldUntil: 50,
			unfoldLimit: 100,
		});
		expect(Object.isFrozen(agent.READ_FOLD_SETTINGS)).toBe(true);
		expect(Object.isFrozen(agent.selectedReadFolder)).toBe(true);
		expect(agent.READ_FOLDER_SELECTION.languages).toEqual({
			ts: "raw",
			js: "wasm",
			json: "heuristic",
			tsx: "raw",
			python: "unsupported",
			rust: "unsupported",
			go: "unsupported",
			markdown: "prose_exempt",
			txt: "prose_exempt",
		});
		expect(agent.READ_FOLDER_SELECTION.head).toMatch(/^[a-f0-9]{40}$/);
		expect(agent.READ_FOLDER_SELECTION.rawReasons).toEqual({
			ts: "wasm_candidate_below_threshold",
			tsx: "wasm_candidate_below_threshold",
		});
		expect(agent.READ_FOLDER_SELECTION.wasm).toBe(true);
		expect(agent.selectedReadFolder.id).toBe("measured-brace");
		expect(agent.selectedReadFolder.version).toBe("3");
	});

	it.each(["ts", "js"])("does not let an enclosing fold consume nested callback signatures in %s", (language) => {
		// Given templates with nested interpolation, escaped strings, comments, regex and division.
		const source = Array.from({ length: 20 }, (_, i) =>
			[
				`function f${i}() {`,
				"  const regex = /[{}\\/]+/g;",
				"  const ratio = 4 / 2;",
				"  /* } [ a comment */",
				`  const nested = \`value \${(() => { return \`nested \${1}\`; })()}\`;`,
				'  const escaped = "\\\\\\"}";',
				"  return ratio;",
				"}",
			].join("\n"),
		).join("\n");
		// When lexing, each outer body overlaps a callback header and cannot be a safe omission.
		expect(fold(source, `file.${language}`)).toEqual({ status: "parsed", text: source, ranges: [] });
	});

	it("builds nested one-class ranges without consuming method headers", () => {
		// Given the frozen one-class case.
		const fixture = boundaryFixtures().find((f) => f.id === "boundary-ts-one-class");
		if (!fixture) throw new Error("Missing frozen fixture");
		// When scanning; then overlap protection rejects the enclosing class fold,
		// while independently proven method implementation bodies remain available.
		const result = fold(fixture.source);
		expect(result).toEqual({
			status: "parsed",
			text: fixture.source,
			ranges: Array.from({ length: 20 }, (_, i) => ({
				startLine: i * 8 + 3,
				endLine: i * 8 + 8,
				children: [],
			})),
		});
	});

	it("folds four-line bodies and six-line ordinary comments, retaining shorter spans and docs", () => {
		// Given bodies/comments immediately below and at the exact thresholds.
		const text =
			"function a() {\n1;\n2;\n3;\n}\nfunction b() {\n1;\n2;\n3;\n4;\n}\n/*\na\nb\nc\n*/\n/*\na\nb\nc\nd\n*/\n/**\na\nb\nc\nd\n*/";
		// When scanning; then only the threshold spans qualify, documentation remains with signatures.
		expect(fold(text)).toEqual({
			status: "parsed",
			text,
			ranges: [
				{ startLine: 7, endLine: 10, children: [] },
				{ startLine: 18, endLine: 21, children: [] },
			],
		});
	});

	it.each(["const {", "const [", "import {", "export {"])(
		"retains declaration header members following %s",
		(header) => {
			// Given a multiline binding/import/export, which is not an implementation body.
			const text = `${header}\na,\nb,\nc,\nd,\ne\n${header.endsWith("[") ? "]" : "}"}${header.startsWith("const") ? " = value;" : " from 'module';"}`;
			// When scanning; then no declaration member may be folded.
			const result = fold(text);
			expect(result).toEqual({ status: "parsed", text, ranges: [] });
		},
	);

	it.each(['"unterminated', "/* unclosed", "`unclosed", "const a = [);", "const a = /[abc/;"])(
		"discards all prior valid folds on trailing malformed syntax %j",
		(suffix) => {
			// Given many valid bodies followed by a malformed span; when scanning; then no partial success.
			expect(fold(`${siblings}\n${suffix}`).status).toBe("parse_failure");
		},
	);

	it.each([
		["function f({", "}) {}"],
		["({", "} = value);"],
		["function f(): {", "} { return value; }"],
		["function f(): Promise<{", "}> { return value; }"],
	])("retains ambiguous signature interiors after %s", (start, end) => {
		// Given header syntax sharing the same brace tokens as an implementation body.
		const text = `${start}\na,\nb,\nc,\nd,\ne\n${end}`;
		// When scanning; then declaration header members cannot become elisions.
		const result = fold(text);
		if (result.status === "parsed") expect(result).toEqual({ status: "parsed", text, ranges: [] });
		else expect(result.status).toBe("parse_failure");
	});

	it.each([
		"const first = 0, {\na,\nb,\nc,\nd,\ne\n} = value;",
		"const first = 0, [\na,\nb,\nc,\nd,\ne\n] = value;",
		"class Example<T extends {\na: string;\nb: string;\nc: string;\nd: string;\ne: string;\n}> {}",
	])("rejects ambiguous binding and generic headers %j", (text) => {
		// Given header members after a comma or in a multiline generic constraint.
		// When the lexical grammar cannot distinguish them from bodies; then fail closed.
		expect(fold(text).status).toBe("parse_failure");
	});

	it("keeps an extensionless language-named path unsupported", () => {
		// Given a file named js, not a .js file; when routing; then it is not a selected language.
		expect(fold(siblings, "src/js")).toEqual({ status: "unsupported", reason: "unsupported_language" });
	});

	it("returns raw on the frozen deep example rather than forcing a misleading score", () => {
		// Given the frozen deep case whose 110-line leaf cannot fit within 100.
		const fixture = boundaryFixtures().find((f) => f.id === "boundary-ts-deep-nesting");
		if (!fixture) throw new Error("Missing frozen fixture");
		// When refining; then exhaustion below 50 is explicit.
		expect(view(fixture.source)).toEqual({ status: "no_summary", reason: "visible_budget_unreachable" });
	});

	it("returns no-summary when marker/footer output costs more than the source saved", () => {
		// Given exactly 100 very short lines and one eligible body.
		const text = `function a(){\n;\n;\n;\n;\n}\n${"\n".repeat(93)}`;
		// When rendering its 96-line skeleton; then synthetic output is included in the savings check.
		expect(view(text)).toEqual({ status: "no_summary", reason: "no_output_saving" });
	});
});
