import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { READ_FOLD_SETTINGS, selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";
import { createSegmentedReadView } from "../../src/harness/utils/segmented-read-view.ts";
import { retainedSourceExact } from "./fixtures/read-summary/oracle.ts";
import { typescriptOracle } from "./fixtures/read-summary/oracle-typescript.ts";
import { overlaps, validBoundaries } from "./fixtures/read-summary/scorer.ts";

const members = ["alpha", "bravo", "charlie", "delta", "echo"].map((name) => ` ${name}: "${name}",`).join("\n");
const object = `{\n${members}\n}`;
const patterns = [
	{ name: "object", source: `({ value = ns.factory(${object}) } = source);` },
	{ name: "array", source: `[value = ns.factory(${object})] = source;` },
	{ name: "nested", source: `({ nested: [value = ns.factory(${object})] } = source);` },
	{ name: "parenthesized", source: `(([value = ns.factory(${object})] = source));` },
];

describe("computed members and assignment targets (#1639)", () => {
	it("retains computed object method headers ending in a later identifier in the direct view", () => {
		// Given a computed name whose closing identifier is on a different line from its object argument.
		const declarations = Array.from(
			{ length: 20 },
			(_, i) => `const object${i} = {\n [ns.factory(${object}) + suffix]() {}\n};`,
		);
		const text = declarations.join("\n");
		expect(() => new Script(text)).not.toThrow();
		const parsed = selectedReadFolder.fold({ path: "input.js", text, settings: READ_FOLD_SETTINGS });
		const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
		for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
		const oracle = typescriptOracle(text, "js");
		// When the public folder and direct view are used, no enclosing or interior range can hide the header.
		for (const range of ranges)
			expect(oracle.protected.some((p) => overlaps({ start: range.startLine, end: range.endLine }, p))).toBe(false);
		const view = createSegmentedReadView({ text, parsed });
		const visible = view.status === "summary" ? view.rendered.text : text;
		for (const declaration of declarations) expect(visible).toContain(declaration);
	});

	it("protects recovered parenthesized targets without treating assignment values as patterns", () => {
		// Given expression-shaped AST targets, even parser recovery must not authorize their interiors.
		const recovered = `(([value = ns.factory(${object})]) = source);`;
		expect(typescriptOracle(recovered, "ts").protected).toContainEqual({ start: 1, end: 7 });
		// When only the right side holds an ordinary object value, then its body remains independently eligible.
		const value = `({ value } = ns.factory(${object}));`;
		expect(() => new Script(value)).not.toThrow();
		expect(typescriptOracle(value, "js").allowed).toContainEqual({ start: 2, end: 6, kind: "body" });
	});

	it.each(patterns)(
		"rejects byte-faithful direct and enclosing omissions of $name assignment targets",
		({ source }) => {
			for (const enclosing of [false, true]) {
				// Given an independently fabricated omission of either the member interior or the whole outer body.
				const text = enclosing ? `function outer() {\n${source}\nreturn value;\n}` : source;
				expect(() => new Script(text)).not.toThrow();
				const lines = text.split("\n");
				const fold = { start: 2, end: lines.length - 1 };
				const output = `${lines[0]}\n…\n${lines.at(-1)}\n\noffset=2 limit=${fold.end - fold.start + 1}`;
				const candidate = { text: output, folds: [fold], reason: "adversarial", scanned_folds: 1 };
				const oracle = typescriptOracle(text, "js");
				expect(retainedSourceExact(text, candidate)).toBe(true);
				// Then the AST oracle independently records the complete target interval and rejects both omissions.
				const start = enclosing ? 2 : 1;
				const end = start + source.split("\n").length - 1;
				expect(oracle.protected).toContainEqual({ start, end });
				expect(validBoundaries({ source: text, folds: [fold], ...oracle, retainedExact: true })).toBe(false);
				const parsed = selectedReadFolder.fold({ path: "input.js", text, settings: READ_FOLD_SETTINGS });
				const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
				for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
				for (const range of ranges)
					expect(overlaps({ start: range.startLine, end: range.endLine }, { start, end })).toBe(false);
			}
		},
	);
});

describe("fields-only class bodies (#1639)", () => {
	it("does not fold a fields-only class body that would hide member declarations", () => {
		const steps = Array.from({ length: 55 }, (_, i) => `ns.step${i}();`).join("\n");
		const fields = Array.from({ length: 12 }, (_, i) => `field${i} = ns.factory(${object});`).join("\n");
		const text = `function outer() {\n${steps}\n}\nclass Example {\n${fields}\n}`;
		expect(text.split("\n")).toHaveLength(143);
		expect(() => new Script(text)).not.toThrow();
		const parsed = selectedReadFolder.fold({ path: "input.js", text, settings: READ_FOLD_SETTINGS });
		const ranges = parsed.status === "parsed" ? [...parsed.ranges] : [];
		for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
		const classBody = { start: 59, end: 142 };
		const oracle = typescriptOracle(text, "js");
		expect(validBoundaries({ source: text, folds: [classBody], ...oracle, retainedExact: true })).toBe(false);
		expect(ranges.some((range) => range.startLine === 59 && range.endLine === 142)).toBe(false);
		for (const range of ranges) {
			const fold = { start: range.startLine, end: range.endLine };
			expect(oracle.protected.some((header) => overlaps(fold, header))).toBe(false);
			expect(validBoundaries({ source: text, folds: [fold], ...oracle, retainedExact: true })).toBe(true);
		}
		const view = createSegmentedReadView({ text, parsed });
		const visible = view.status === "summary" ? view.rendered.text : text;
		for (let i = 0; i < 12; i++) expect(visible).toContain(`field${i} = ns.factory({`);
	});
});
